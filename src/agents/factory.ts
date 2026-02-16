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
import type { AgentConfig, AgentRegistry } from "./registry.js";

import { createSandboxedFileSystem } from "../security/sandbox-fs.js";
import { createAgentRuntime } from "../agent/runtime.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { createContextBuilder } from "../agent/context.js";
import { createSessionManager } from "../agent/session.js";
import { createToolRegistry } from "../agent/tools/registry.js";
import { createWebFetchTool } from "../agent/tools/web-fetch.js";
import {
  createFileReadTool,
  createFileWriteTool,
  createFileListTool,
} from "../agent/tools/file-operations.js";
import {
  createMemorySearchTool,
  createMemoryStoreTool,
  createMemoryForgetTool,
} from "../agent/tools/memory-tools.js";
import {
  createRememberTool,
  createSecurityReportTool,
  createProgressReportTool,
} from "../agent/tools/response-tools.js";
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
  /** Optional: for flat agent architecture — agent registry for create_agent / agent_list */
  agentRegistry?: AgentRegistry;
  /** Optional: creates and activates a new agent (for create_agent when Maia approves). */
  createRuntime?: (config: AgentConfig) => SubAgent;
  /** Optional: map of active agents (for create_agent tool). */
  activeAgents?: Map<string, SubAgent>;
  /** Optional: agent creation requests repo (for create_agent when non-Maia requests). */
  creationRequestsRepo?: import("./agent-creation-requests.js").AgentCreationRequestsRepository;
  /** Optional: called when a non-Maia agent submits a creation request. */
  onAgentCreationRequest?: (request: import("./agent-creation-requests.js").AgentCreationRequest) => void;
  /** Optional: records each LLM request/response for audit and per-thread views. */
  logLlmCall?: (params: {
    agentId: string;
    sessionId: string;
    threadId?: string | null;
    requestMessages: Array<{ role: string; content: string; name?: string }>;
    responseContent: string;
    responseToolCalls?: unknown[];
  }) => Promise<void>;
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

  // Tool registry (agent-specific tools). All agents get all tools.
  const toolRegistry = createToolRegistry({ logger, auditLog });

  const ssrfGuard = createSsrfGuard({ blockPrivateIPs: config.security.ssrf.blockPrivateIPs });
  toolRegistry.register(createWebFetchTool({ http, ssrfGuard, logger }));

  toolRegistry.register(createFileReadTool({ fs: agentFs, logger }));
  toolRegistry.register(createFileWriteTool({ fs: agentFs, logger }));
  toolRegistry.register(createFileListTool({ fs: agentFs, logger }));

  const memoryStore = createMemoryStore({ db, crypto, logger, agentId: agentConfig.id });
  toolRegistry.register(createMemorySearchTool({ store: memoryStore, logger }));
  toolRegistry.register(createMemoryStoreTool({ store: memoryStore, logger }));
  toolRegistry.register(createMemoryForgetTool({ store: memoryStore, logger }));

  // Response tools: remember, security_report, progress_report (LLM invokes these instead of inline blocks)
  toolRegistry.register(createRememberTool({ fs: agentFs, logger, workspacePath: agentWorkspacePath }));
  toolRegistry.register(createSecurityReportTool({}));
  toolRegistry.register(createProgressReportTool());

  // create_agent, message, agent_list, set_identity are registered in index after sub-agent creation
  // when sharedAgentDeps includes agentRegistry, createRuntime, activeAgents, creationRequestsRepo, onAgentCreationRequest

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
      // Sub-agent replies are collected by the caller (e.g. message tool with agent recipientId)
    },
    mergeStrategy,
    onAfterReply: async ({ userContent, responseContent, privacyMode }) => {
      if (privacyMode) {
        await dailyLog.append("[private exchange]");
        return;
      }
      await dailyLog.append(`User: ${userContent}\nAssistant: ${responseContent}`);
    },
    agentId: agentConfig.id,
    logLlmCall: shared.logLlmCall,
  });

  return {
    config: agentConfig,
    runtime,
    workspacePath: agentWorkspacePath,
  };
}
