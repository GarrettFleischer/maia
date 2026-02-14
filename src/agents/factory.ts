/**
 * @fileoverview Per-agent runtime factory. Creates a fully independent agent
 * runtime for each sub-agent with its own sandboxed filesystem, context builder,
 * session manager, tool registry, daily log, and incremental memory extraction.
 * @module agents/factory
 *
 * @note All sub-agents share the provider registry, database, crypto, HTTP client,
 * clock, and audit log. Everything else (workspace, tools, sessions, memory) is
 * isolated per agent.
 */

import type {
  AuditLog,
  Clock,
  CryptoProvider,
  Database,
  EventBus,
  FileSystem,
  Logger,
  MaiaConfig,
} from "../core/types.js";
import type { ProviderRegistry } from "../providers/base.js";
import type { AgentConfig } from "./registry.js";

import { createSandboxedFileSystem } from "../security/sandbox-fs.js";
import { createAgentRuntime } from "../agent/runtime.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { AgentTool } from "../agent/tools/base.js";
import { createContextBuilder } from "../agent/context.js";
import { createSessionManager } from "../agent/session.js";
import { createToolRegistry } from "../agent/tools/registry.js";
import { createWebFetchTool } from "../agent/tools/web-fetch.js";
import {
  createMemorySearchTool,
  createMemoryStoreTool,
  createMemoryForgetTool,
} from "../agent/tools/memory-tools.js";
import { createMemoryStore } from "../memory/store.js";
import { createRememberBlockHandler } from "../memory/remember-block.js";
import { createAutoRecall } from "../memory/auto-recall.js";
import { createDailyLog } from "../memory/daily-log.js";
import { createPeriodicMerge } from "../memory/periodic-merge.js";
import { createSsrfGuard } from "../security/ssrf-guard.js";
import { createRealHttpClient } from "../adapters/http-client.js";

/**
 * @brief Shared dependencies provided by the main app to all agent runtimes.
 */
export interface SharedAgentDeps {
  db: Database;
  crypto: CryptoProvider;
  http: ReturnType<typeof createRealHttpClient>;
  clock: Clock;
  auditLog: AuditLog;
  events: EventBus;
  logger: Logger;
  config: MaiaConfig;
  providerRegistry: ProviderRegistry;
  /** Raw (unsandboxed) filesystem for creating per-agent sandboxes */
  rawFs: FileSystem;
  /** Optional dynamic tools (from tools folder) to register for every agent */
  dynamicTools?: AgentTool[];
}

/**
 * @brief A fully wired sub-agent instance.
 */
export interface SubAgent {
  /** The agent's configuration */
  config: AgentConfig;
  /** The agent's runtime for processing messages */
  runtime: AgentRuntime;
  /** The agent's workspace path */
  workspacePath: string;
}

/**
 * @brief Creates a fully independent runtime for a sub-agent.
 * @param agentConfig - The agent's configuration
 * @param agentWorkspacePath - Absolute path to the agent's workspace directory
 * @param shared - Shared dependencies from the main app
 * @returns SubAgent with runtime, config, and workspace path
 *
 * @example
 * const subAgent = createSubAgentRuntime(agentConfig, "/home/user/.maia/workspace/agents/research-bot", shared);
 * const response = await subAgent.runtime.handleMessage(message);
 */
export function createSubAgentRuntime(
  agentConfig: AgentConfig,
  agentWorkspacePath: string,
  shared: SharedAgentDeps
): SubAgent {
  const { db, crypto, http, clock, auditLog, events, logger, config, providerRegistry } = shared;

  // Create sandboxed filesystem for this agent
  const agentFs = createSandboxedFileSystem({
    inner: shared.rawFs,
    root: agentWorkspacePath,
    auditLog,
    logger,
  });

  // Create agent-specific config overlay (use agent's identity but share base config)
  const agentMaiaConfig: MaiaConfig = {
    ...config,
    identity: {
      name: agentConfig.name,
      emoji: agentConfig.emoji,
      personality: agentConfig.personality,
    },
    workspace: {
      ...config.workspace,
      path: agentWorkspacePath,
    },
  };

  // Session manager (isolated per agent)
  const sessionManager = createSessionManager({
    contextWindowSize: 4096,
    compactionThresholdPercent: config.session.compaction.thresholdPercent,
    preserveRecentMessages: config.session.compaction.preserveRecentMessages,
    logger,
    clock,
  });

  // Context builder (reads from agent's workspace)
  const contextBuilder = createContextBuilder({
    fs: agentFs,
    config: agentMaiaConfig,
    logger,
  });

  // Tool registry (agent-specific tools)
  const toolRegistry = createToolRegistry({ logger });

  // Register tools based on agent config
  const allowedTools = new Set(agentConfig.tools);

  if (allowedTools.has("web_fetch")) {
    const ssrfGuard = createSsrfGuard({ blockPrivateIPs: config.security.ssrf.blockPrivateIPs });
    toolRegistry.register(createWebFetchTool({ http, ssrfGuard, logger }));
  }

  // Memory tools (always scoped to agent's namespace)
  const memoryStore = createMemoryStore({ db, crypto, logger, agentId: agentConfig.id });

  if (allowedTools.has("memory_search")) {
    toolRegistry.register(createMemorySearchTool({ store: memoryStore, logger }));
  }
  if (allowedTools.has("memory_store")) {
    toolRegistry.register(createMemoryStoreTool({ store: memoryStore, logger }));
  }
  if (allowedTools.has("memory_forget")) {
    toolRegistry.register(createMemoryForgetTool({ store: memoryStore, logger }));
  }

  if (shared.dynamicTools) {
    for (const tool of shared.dynamicTools) {
      toolRegistry.register(tool);
    }
  }

  // Auto-recall for this agent's memories
  const autoRecall = createAutoRecall({
    store: memoryStore,
    logger,
    limit: config.memory.search.defaultLimit,
  });

  // Daily log for this agent
  const dailyLog = createDailyLog({
    fs: agentFs,
    clock,
    auditLog,
    basePath: `${agentWorkspacePath}/memory`,
  });

  // Resolve which provider to use for this agent
  const agentProvider = (() => {
    try {
      // Try to get the specific provider configured for this agent
      const provider = providerRegistry.get(agentConfig.model.provider);
      if (provider) return provider;
    } catch {
      // Fall through to primary
    }
    return providerRegistry.getPrimary();
  })();

  // Remember block: append to this agent's workspace (MEMORY.md, USER.md, SOUL.md)
  const rememberBlockHandler = createRememberBlockHandler({
    fs: agentFs,
    logger,
    workspacePath: agentWorkspacePath,
  });

  // Periodic merge for this agent (batch memory with chat every 10 min)
  const mergeStrategy = createPeriodicMerge({
    fs: agentFs,
    db,
    logger,
    llm: agentProvider,
    workspacePath: agentWorkspacePath,
    contextBuilder,
    dailyLog,
    clock,
    recallMemory: async (query: string) => autoRecall.formatContextBlock(query),
    mergeIntervalMs: 10 * 60 * 1000,
  });

  // Build the runtime
  const runtime = createAgentRuntime({
    config: agentMaiaConfig,
    logger,
    events,
    provider: agentProvider,
    sessionManager,
    contextBuilder,
    toolRegistry,
    parseRemember: (raw) => rememberBlockHandler.parseAndApply(raw),
    recallMemory: async (query: string) => {
      return await autoRecall.formatContextBlock(query);
    },
    sendReply: async () => {
      // Sub-agent replies are collected by the caller (e.g. agent_message tool)
    },
    mergeStrategy,
    onAfterReply: async ({ userContent, responseContent, privacyMode }) => {
      if (privacyMode) {
        await dailyLog.append("[private exchange]");
        return;
      }
      await dailyLog.append(`User: ${userContent}\nAssistant: ${responseContent}`);
    },
  });

  return {
    config: agentConfig,
    runtime,
    workspacePath: agentWorkspacePath,
  };
}
