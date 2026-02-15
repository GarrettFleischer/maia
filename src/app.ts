/**
 * @fileoverview Application composition root. Wires all modules together into
 * a fully functional MaiaApp with proper dependency injection.
 * @module app
 *
 * @note This is the single place where all production dependencies are
 * instantiated and connected. No module creates its own dependencies --
 * everything flows through this composition root.
 */

import * as os from "node:os";
import * as path from "node:path";

import type {
  FileSystem,
  MaiaConfig,
  MaiaContext,
  LLMProvider,
} from "./core/types.js";

// Adapters
import { createRealFileSystem } from "./adapters/filesystem.js";
import { createSQLiteDatabase } from "./adapters/database.js";
import { createRealCryptoProvider } from "./adapters/crypto.js";
import { createRealHttpClient } from "./adapters/http-client.js";
import { createRealClock } from "./adapters/clock.js";
import { createRealEnvProvider } from "./adapters/env.js";

// Core
import { loadConfig } from "./core/config/loader.js";
import { ConfigError } from "./core/errors.js";
import { createLogger } from "./core/logger.js";
import { createEventBus } from "./core/events.js";
import { createShutdownCoordinator } from "./core/shutdown.js";
import { createMigrationRunner } from "./core/migrations/runner.js";
import { createApplicationFileSystem } from "./core/compose-fs.js";

// Security
import { createAuditLog } from "./security/audit-log.js";
import { createCredentialStore } from "./security/credential-store.js";
import { createSsrfGuard } from "./security/ssrf-guard.js";

// Providers
import { createProviderRegistry } from "./providers/base.js";
import type { ProviderRegistry } from "./providers/base.js";
import { createOllamaProvider } from "./providers/ollama.js";
import { createGroqProvider } from "./providers/groq.js";
import { createGeminiProvider } from "./providers/gemini.js";
import { createHuggingFaceProvider } from "./providers/huggingface.js";
import { createOpenRouterProvider } from "./providers/openrouter.js";

// Agent
import { createAgentRuntime } from "./agent/runtime.js";
import type { AgentRuntime } from "./agent/runtime.js";
import { createContextBuilder } from "./agent/context.js";
import { createSessionManager } from "./agent/session.js";
import { createToolRegistry } from "./agent/tools/registry.js";
import { createWebFetchTool } from "./agent/tools/web-fetch.js";
import {
  createMemorySearchTool,
  createMemoryStoreTool,
  createMemoryForgetTool,
} from "./agent/tools/memory-tools.js";
import { createPrivacyManager } from "./agent/privacy.js";
import { createThreadTracker } from "./agent/threading.js";

// Memory
import { createMemoryStore } from "./memory/store.js";
import { createAutoRecall } from "./memory/auto-recall.js";
import { createDailyLog } from "./memory/daily-log.js";
import { createPeriodicMerge } from "./memory/periodic-merge.js";
import { createRememberBlockHandler } from "./memory/remember-block.js";

// Agents
import { createAgentRegistry } from "./agents/registry.js";
import type { AgentRegistry, AgentConfig } from "./agents/registry.js";
import { createSubAgentRuntime } from "./agents/factory.js";
import type { SubAgent, SharedAgentDeps } from "./agents/factory.js";
import {
  createAgentCreateTool,
  createAgentListTool,
  createAgentRemoveTool,
  createAgentMessageTool,
  createAgentInspectTool,
  createAgentUpdateTool,
} from "./agents/tools.js";

/**
 * @brief Options for creating the application.
 */
export interface CreateAppOptions {
  /** Path to the JSON config file. Defaults to ~/.maia/maia.config.json */
  configPath?: string;
  /** Path to the data directory. Defaults to ~/.maia/data */
  dataDir?: string;
  /** Ref to a function that returns the onAgentCreated callback (set by host after orchestrator exists). */
  getOnAgentCreatedRef?: { current: (() => (subAgent: SubAgent) => void) | null };
  /** Ref to TaskMonitor (set by host after task monitor exists) for agent_list assigned tasks. */
  taskMonitorRef?: { current: import("./agents/task-monitor.js").TaskMonitor | null };
  /** Ref to get queue status summary (set by host when Maia is the brain). Injected into LLM context only when set. */
  getQueueStatusSummaryRef?: { current: (() => string) | null };
}

/**
 * @brief The fully wired application instance.
 */
export interface MaiaApp {
  /** @brief Returns the assembled MaiaContext */
  getContext(): MaiaContext;
  /** @brief Returns the agent runtime */
  getRuntime(): AgentRuntime;
  /** @brief Returns the provider registry */
  getProviderRegistry(): ProviderRegistry;
  /** @brief Returns the agent registry for sub-agent management */
  getAgentRegistry(): AgentRegistry;
  /** @brief Returns the map of active sub-agent runtimes */
  getActiveAgents(): Map<string, SubAgent>;
  /** @brief Returns the raw (unsandboxed) filesystem */
  getRawFs(): FileSystem;
  /** @brief Returns the data directory path (e.g. for queue.json) */
  getDataDir(): string;
  /** @brief Gracefully shuts down all subsystems */
  stop(): Promise<void>;
}

/**
 * @brief Expands ~ to the user's home directory.
 * @param p - Path that may start with ~
 * @returns Resolved absolute path
 */
function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * @brief Creates and wires the complete Maia application.
 * @param options - Optional configuration overrides
 * @returns Fully wired MaiaApp instance
 *
 * @note Construction order:
 * 1. Primitives (clock, env, logger, events, shutdown)
 * 2. Raw filesystem + config loading
 * 3. Audit log + sandboxed filesystem
 * 4. Database + crypto + HTTP
 * 5. Credential store
 * 6. Assemble MaiaContext
 * 7. Run migrations
 * 8. Providers + agent subsystems
 *
 * @example
 * const app = await createApp({ configPath: "~/.maia/config.json" });
 * const ctx = app.getContext();
 * const runtime = app.getRuntime();
 * // ... use the app ...
 * await app.stop();
 */
export async function createApp(options?: CreateAppOptions): Promise<MaiaApp> {
  // ── Step 1: Primitives ───────────────────────────────────────────

  const clock = createRealClock();
  const env = createRealEnvProvider();
  const logLevel = (env.get("MAIA_LOG_LEVEL") ?? "info") as "debug" | "info" | "warn" | "error";
  const logger = createLogger({ level: logLevel, write: (line) => process.stdout.write(line + "\n") });
  const events = createEventBus();
  const shutdown = createShutdownCoordinator({ logger });

  // ── Step 2: Raw filesystem + config ──────────────────────────────

  const rawFs = createRealFileSystem();
  const defaultConfigPath = expandHome("~/.maia/maia.config.json");
  const configPath = options?.configPath ?? env.get("MAIA_CONFIG") ?? defaultConfigPath;

  const config: MaiaConfig = await loadConfig(configPath, { fs: rawFs, env, logger });

  // ── Step 3: Resolve paths ────────────────────────────────────────

  const defaultDataDir = expandHome("~/.maia/data");
  const dataDir = options?.dataDir ?? defaultDataDir;
  const workspacePath = expandHome(config.workspace.path);
  const dbPath = path.join(dataDir, "maia.db");
  const auditLogPath = path.join(dataDir, "audit.jsonl");
  const vaultPath = path.join(dataDir, "credentials.enc");
  const migrationsPath = path.resolve("src/core/migrations/migrations");

  // Ensure data directory exists
  await rawFs.mkdir(dataDir);

  // ── Step 4: Audit log (needs fs + clock before sandbox) ──────────

  const auditLog = createAuditLog({ fs: rawFs, clock, logPath: auditLogPath });

  // ── Step 5: Sandboxed filesystem ─────────────────────────────────

  const fs = createApplicationFileSystem(rawFs, config, auditLog, logger);

  // ── Step 6: Database ─────────────────────────────────────────────

  const db = createSQLiteDatabase(dbPath);
  shutdown.register("database", async () => {
    await db.close();
    logger.info("Database closed");
  }, 10);

  // ── Step 7: Crypto + HTTP ────────────────────────────────────────

  const crypto = createRealCryptoProvider();
  const http = createRealHttpClient();

  // ── Step 8: Derive master key + credential store ─────────────────

  const masterKeyPassphrase = env.get("MAIA_MASTER_KEY");
  if (!masterKeyPassphrase || masterKeyPassphrase.length === 0) {
    throw new ConfigError(
      "MAIA_MASTER_KEY is not set. Run 'maia onboard' or set MAIA_MASTER_KEY in your .env file."
    );
  }
  const salt = new TextEncoder().encode(`maia-salt-${workspacePath}`);
  const masterKey = await crypto.deriveKey(masterKeyPassphrase, salt);

  const credentials = createCredentialStore({
    fs: rawFs,
    crypto,
    auditLog,
    logger,
    vaultPath,
    masterKey,
  });

  // ── Step 9: Assemble MaiaContext ─────────────────────────────────

  const ctx: MaiaContext = {
    config,
    fs,
    clock,
    env,
    http,
    crypto,
    db,
    logger,
    events,
    credentials,
    auditLog,
    shutdown,
  };

  // ── Step 10: Run migrations ──────────────────────────────────────

  const migrationRunner = createMigrationRunner({
    db,
    fs: rawFs,
    logger,
    migrationsPath,
  });
  await migrationRunner.run();

  // ── Step 11: Provider registry ───────────────────────────────────

  const providerRegistry = createProviderRegistry(ctx);
  registerProviders(providerRegistry, config, http, credentials, logger);

  // ── Step 12: Agent subsystems ────────────────────────────────────

  const sessionManager = createSessionManager({
    contextWindowSize: 4096,
    compactionThresholdPercent: config.session.compaction.thresholdPercent,
    preserveRecentMessages: config.session.compaction.preserveRecentMessages,
    logger,
    clock,
  });

  const contextBuilder = createContextBuilder({ fs, config, logger });
  const threadTracker = createThreadTracker();
  const privacyManager = createPrivacyManager({ auditLog });

  const toolRegistry = createToolRegistry({ logger });

  // Register built-in tools
  const ssrfGuard = createSsrfGuard({ blockPrivateIPs: config.security.ssrf.blockPrivateIPs });
  toolRegistry.register(createWebFetchTool({ http, ssrfGuard, logger }));

  // ── Step 13: Agent registry + management tools ───────────────────

  const agentRegistry = createAgentRegistry({ fs, db, logger, workspacePath });
  const activeAgents = new Map<string, SubAgent>();

  /** @brief Shared deps for creating sub-agent runtimes */
  const sharedAgentDeps: SharedAgentDeps = {
    db, crypto, http, clock, auditLog, events, logger, config,
    providerRegistry,
    rawFs,
  };

  /** @brief Creates a sub-agent runtime and adds it to the active agents map */
  const createAndActivateAgent = (agentConfig: AgentConfig): SubAgent => {
    const agentWorkspace = agentRegistry.agentWorkspacePath(agentConfig.id);
    const subAgent = createSubAgentRuntime(agentConfig, agentWorkspace, sharedAgentDeps);
    activeAgents.set(agentConfig.id, subAgent);
    return subAgent;
  };

  // Register Maia's agent management tools (crypto for request IDs; onAgentCreated from options for post-create tool registration)
  const agentToolDeps = {
    registry: agentRegistry,
    logger,
    createRuntime: createAndActivateAgent,
    activeAgents,
    crypto,
    onAgentCreated: options?.getOnAgentCreatedRef
      ? (sub: SubAgent) => options.getOnAgentCreatedRef!.current?.()?.(sub)
      : undefined,
    taskMonitorRef: options?.taskMonitorRef,
  };
  toolRegistry.register(createAgentCreateTool(agentToolDeps));
  toolRegistry.register(createAgentListTool(agentToolDeps));
  toolRegistry.register(createAgentRemoveTool(agentToolDeps));
  toolRegistry.register(createAgentMessageTool(agentToolDeps));
  toolRegistry.register(createAgentInspectTool(agentToolDeps));
  toolRegistry.register(createAgentUpdateTool(agentToolDeps));

  // Register memory tools if memory is enabled
  if (config.memory.enabled) {
    const memoryStore = createMemoryStore({ db, crypto, logger });
    toolRegistry.register(createMemorySearchTool({ store: memoryStore, logger }));
    toolRegistry.register(createMemoryStoreTool({ store: memoryStore, logger }));
    toolRegistry.register(createMemoryForgetTool({ store: memoryStore, logger }));

    // Auto-recall
    const autoRecall = createAutoRecall({
      store: memoryStore,
      logger,
      limit: config.memory.search.defaultLimit,
    });

    // Daily log for Tier 1 audit trail
    const dailyLog = createDailyLog({
      fs,
      clock,
      auditLog,
      basePath: `${workspacePath}/memory`,
    });

    // Optional "remember" block in every reply: LLM can append ---REMEMBER--- + JSON to persist to MEMORY/USER/SOUL
    const rememberBlockHandler = createRememberBlockHandler({
      fs,
      logger,
      workspacePath,
    });

    // Periodic merge: every 10 min, combine user chat with memory extraction from daily log since last merge
    const mergeStrategy = createPeriodicMerge({
      fs,
      db,
      logger,
      llm: getActiveProvider(providerRegistry),
      workspacePath,
      contextBuilder,
      dailyLog,
      clock,
      recallMemory: async (query: string) => {
        const block = await autoRecall.formatContextBlock(query);
        return block;
      },
      getThreadSummary: (_sessionId: string) => {
        const threads = threadTracker.listThreads();
        return threads.length > 0
          ? threads.map((t) => t.topic).join(", ")
          : undefined;
      },
      mergeIntervalMs: 10 * 60 * 1000,
    });

    // Build runtime with memory recall and periodic merge
    const runtime = createAgentRuntime({
      config,
      logger,
      events,
      provider: getActiveProvider(providerRegistry),
      sessionManager,
      contextBuilder,
      toolRegistry,
      recallMemory: async (query: string) => {
        const block = await autoRecall.formatContextBlock(query);
        return block;
      },
      getThreadSummary: (_sessionId: string) => {
        const threads = threadTracker.listThreads();
        return threads.length > 0
          ? threads.map((t) => t.topic).join(", ")
          : undefined;
      },
      isPrivacyActive: (sessionId: string) =>
        privacyManager.isPrivate(sessionId),
      sendReply: async () => {
        // Will be wired by the channel/CLI layer later
      },
      mergeStrategy,
      parseRemember: (raw) => rememberBlockHandler.parseAndApply(raw),
      onAfterReply: async ({ userContent, responseContent, privacyMode }) => {
        if (privacyMode) {
          await dailyLog.append("[private exchange]");
          return;
        }
        // Append exchange to daily log (Tier 1). Memory extraction runs in merge path.
        await dailyLog.append(`User: ${userContent}\nAssistant: ${responseContent}`);
      },
      getQueueStatusSummaryRef: options?.getQueueStatusSummaryRef,
    });

    return buildApp(ctx, runtime, providerRegistry, shutdown, logger, agentRegistry, activeAgents, rawFs, dataDir);
  }

  // Build runtime without memory
  const runtime = createAgentRuntime({
    config,
    logger,
    events,
    provider: getActiveProvider(providerRegistry),
    sessionManager,
    contextBuilder,
    toolRegistry,
    getThreadSummary: (_sessionId: string) => {
      const threads = threadTracker.listThreads();
      return threads.length > 0
        ? threads.map((t) => t.topic).join(", ")
        : undefined;
    },
    isPrivacyActive: (sessionId: string) =>
      privacyManager.isPrivate(sessionId),
    sendReply: async () => {
      // Will be wired by the channel/CLI layer later
    },
    getQueueStatusSummaryRef: options?.getQueueStatusSummaryRef,
  });

  return buildApp(ctx, runtime, providerRegistry, shutdown, logger, agentRegistry, activeAgents, rawFs, dataDir);
}

/**
 * @brief Registers LLM providers based on config.
 * @param registry - Provider registry to register into
 * @param config - Application config
 * @param http - HTTP client
 * @param credentials - Credential store
 * @param logger - Logger
 */
function registerProviders(
  registry: ProviderRegistry,
  config: MaiaConfig,
  http: ReturnType<typeof createRealHttpClient>,
  credentials: ReturnType<typeof createCredentialStore>,
  logger: ReturnType<typeof createLogger>
): void {
  // Always register Ollama (no credentials needed)
  if (config.provider.ollama) {
    registry.register(
      createOllamaProvider({
        http,
        logger,
        baseUrl: config.provider.ollama.baseUrl,
        model: config.provider.model,
      })
    );
  }

  // Register credential-based providers if configured
  if (config.provider.groq) {
    registry.register(
      createGroqProvider({
        http,
        credentials,
        logger,
        credentialName: config.provider.groq.credentialName,
      })
    );
  }

  if (config.provider.gemini) {
    registry.register(
      createGeminiProvider({
        http,
        credentials,
        logger,
        credentialName: config.provider.gemini.credentialName,
      })
    );
  }

  if (config.provider.huggingface) {
    registry.register(
      createHuggingFaceProvider({
        http,
        credentials,
        logger,
        credentialName: config.provider.huggingface.credentialName,
      })
    );
  }

  if (config.provider.openrouter) {
    registry.register(
      createOpenRouterProvider({
        http,
        credentials,
        logger,
        credentialName: config.provider.openrouter.credentialName,
      })
    );
  }
}

/**
 * @brief Gets the active LLM provider (primary, or throws).
 * @param registry - Provider registry
 * @returns The primary LLM provider
 */
function getActiveProvider(registry: ProviderRegistry): LLMProvider {
  return registry.getPrimary();
}

/**
 * @brief Constructs the MaiaApp object.
 * @param ctx - Assembled MaiaContext
 * @param runtime - Agent runtime
 * @param providerRegistry - Provider registry
 * @param shutdown - Shutdown coordinator
 * @param logger - Logger
 * @returns MaiaApp instance
 */
function buildApp(
  ctx: MaiaContext,
  runtime: AgentRuntime,
  providerRegistry: ProviderRegistry,
  shutdown: ReturnType<typeof createShutdownCoordinator>,
  logger: ReturnType<typeof createLogger>,
  agentRegistry: AgentRegistry,
  activeAgents: Map<string, SubAgent>,
  rawFs: FileSystem,
  dataDir: string,
): MaiaApp {
  return {
    getContext: () => ctx,
    getRuntime: () => runtime,
    getProviderRegistry: () => providerRegistry,
    getAgentRegistry: () => agentRegistry,
    getActiveAgents: () => activeAgents,
    getRawFs: () => rawFs,
    getDataDir: () => dataDir,
    async stop(): Promise<void> {
      logger.info("Shutting down Maia...");
      await shutdown.shutdown("app.stop() called");
      logger.info("Maia shut down complete.");
    },
  };
}
