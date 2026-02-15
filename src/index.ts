/**
 * @fileoverview Main entry point and CLI for the Maia AI assistant.
 * @module index
 *
 * @note This file handles CLI command parsing and bootstraps the application.
 * Available commands: start, chat, onboard, credentials, backup, restore,
 * schedule, watchdog, doctor. If no command is given, help is shown.
 */

import { createApp } from "./app.js";

// Gateway
import { createGatewayServer } from "./gateway/server.js";
import { createRouter } from "./gateway/router.js";
import { createWSHandler } from "./gateway/ws-handler.js";
import { createAuthMiddleware } from "./gateway/middleware/auth.js";
import { createRateLimitMiddleware } from "./gateway/middleware/rate-limit.js";
import { createCorsMiddleware } from "./gateway/middleware/cors.js";
import { createErrorHandler } from "./gateway/middleware/error-handler.js";
import {
  startBunServer,
  registerApiRoutes,
  type OnWsConnect,
} from "./gateway/bun-server.js";

// Channels
import { createTelegramChannel } from "./channels/telegram.js";
import { createMessageFormatter } from "./channels/formatter.js";

// Dashboard / Agent orchestration
import { registerDashboardRoutes } from "./gateway/dashboard-routes.js";
import { createThreadService } from "./threads/service.js";
import { createTaskMonitor } from "./agents/task-monitor.js";
import { createOrchestrator, type OrchestratorQueue } from "./agents/orchestrator.js";
import { createQueueManager } from "./providers/queue-manager.js";
import type { HandleMessageResult } from "./agent/runtime.js";
import type { InboundMessage } from "./core/types.js";
import { createApprovedSnippetsRepository } from "./security/approved-snippets.js";
import { createAgentCreationRequestsRepository } from "./agents/agent-creation-requests.js";
import { createMcpServerProposalsRepository } from "./agents/mcp-server-proposals.js";
import { createWidgetReviewRequestsRepository } from "./agents/widget-review-requests.js";
import type { WidgetReviewRequest } from "./agents/widget-review-requests.js";
import { createApprovedDashboardWidgetsRepository } from "./agents/approved-dashboard-widgets.js";
import { createMemoryStore } from "./memory/store.js";

// Watchdog
import { createWatchdogDaemon } from "./watchdog/daemon.js";
import { createThreatDetector } from "./watchdog/threat-detector.js";
import { createAlerter } from "./watchdog/alerter.js";
import { createAuditMonitor } from "./watchdog/monitor.js";
import { createEmergencyShutdown } from "./watchdog/shutdown.js";

// Backup
import { createBackupExporter } from "./backup/export.js";
import { createBackupRestorer } from "./backup/restore.js";

// Workspace
import { createBootstrap } from "./workspace/bootstrap.js";

// Adapters (for minimal boot utilities)
import { createRealFileSystem } from "./adapters/filesystem.js";
import { createRealCryptoProvider } from "./adapters/crypto.js";
import { createRealEnvProvider } from "./adapters/env.js";
import { createRealClock } from "./adapters/clock.js";
import { createRealHttpClient } from "./adapters/http-client.js";
import { createAuditLog } from "./security/audit-log.js";
import { createCredentialStore } from "./security/credential-store.js";
import type {
  CredentialStore,
  ModelInfo,
  StoredCredential,
} from "./core/types.js";
import { createOllamaProvider } from "./providers/ollama.js";
import { createGroqProvider } from "./providers/groq.js";
import { createGeminiProvider } from "./providers/gemini.js";
import { createHuggingFaceProvider } from "./providers/huggingface.js";
import { createOpenRouterProvider } from "./providers/openrouter.js";
import { createLogger } from "./core/logger.js";
import { createMCPBridgeTools } from "./mcp/bridge.js";
import { createSubAgentRuntime } from "./agents/factory.js";
import type { SubAgent, SharedAgentDeps } from "./agents/factory.js";
import type { AgentConfig } from "./agents/registry.js";
import type {
  AgentCreationRequest,
  AgentCreationRequestsRepository,
} from "./agents/agent-creation-requests.js";
import type { McpServerProposal } from "./agents/mcp-server-proposals.js";
import {
  createAgentCreateTool,
  createAgentListTool,
  PLACEHOLDER_NAME,
  PLACEHOLDER_SOUL,
} from "./agents/tools.js";
import { createScheduler } from "./agent/scheduler.js";
import { createChatWithAgentTool } from "./agents/tools/chat-with-agent.js";
import { createDmUserTool } from "./agents/tools/dm-user.js";
import { createSetIdentityTool } from "./agents/tools/set-identity.js";
import { createProposeMcpServerTool } from "./agents/tools/propose-mcp-server.js";
import { createSubmitWidgetForReviewTool } from "./agents/tools/submit-widget-for-review.js";
import { createCheckQueueJobTool } from "./agents/tools/check-queue-job.js";
import { createTaskManageTool } from "./agents/tools/task-manage.js";
import type { TaskMonitor } from "./agents/task-monitor.js";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

/**
 * @brief Loads KEY=VALUE lines from a .env file into process.env.
 * @param envPath - Absolute path to the .env file
 * @note Skips empty lines and # comments; strips optional surrounding quotes from values.
 */
function loadEnvFile(envPath: string): void {
  try {
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      )
        value = value.slice(1, -1);
      if (key) process.env[key] = value;
    }
  } catch {
    // Ignore read/parse errors; process.env stays unchanged
  }
}

/**
 * @brief Loads environment variables so MAIA_* (e.g. MAIA_AUTH_TOKEN) are available.
 * Loads in order: process.cwd()/.env (project), then ~/.maia/.env (canonical).
 * Later files override earlier, so ~/.maia/.env wins for overlapping keys.
 * @note Ensures maia chat/start use the same MAIA_* vars whether run from repo or from home.
 */
function loadMaiaEnv(): void {
  loadEnvFile(path.resolve(process.cwd(), ".env"));
  loadEnvFile(path.join(os.homedir(), ".maia", ".env"));
}

loadMaiaEnv();

const args = process.argv.slice(2);
const command = args[0] ?? "help";

/**
 * @brief Prints usage information.
 */
function printHelp(): void {
  console.log(`
Maia - Personal AI Assistant

Usage: maia <command> [options]

Commands:
  start              Start gateway + watchdog + channels
  chat               Interactive CLI chat

  onboard            First-run setup wizard

  credentials add    Add an API key to the encrypted vault
  credentials list   List stored credential names
  credentials remove Remove a credential

  backup [path]      Create encrypted backup archive
  restore <path>     Restore from backup

  schedule list      List scheduled tasks
  schedule add       Add a reminder or recurring task
  schedule remove    Remove a scheduled task

  watchdog           Run watchdog standalone
  doctor             One-shot health check

  --help, -h         Show this help message
  --version, -v      Show version

Run maia with no command to show this help.
`);
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
 * @brief In-memory credential store for onboarding (fetch models before vault exists).
 * @param credentialName - Key name to store
 * @param value - Secret value
 * @returns CredentialStore that exposes a single credential
 */
function createMemoryCredentialStore(
  credentialName: string,
  value: string,
): CredentialStore {
  const stored: StoredCredential = { value, addedAt: new Date().toISOString() };
  return {
    async get(name: string): Promise<StoredCredential> {
      if (name !== credentialName)
        throw new Error("Unknown credential: " + name);
      return stored;
    },
    async set(name: string, val: string): Promise<void> {
      if (name === credentialName) {
        stored.value = val;
        stored.addedAt = new Date().toISOString();
      }
    },
    async remove(): Promise<void> {},
    async list(): Promise<Array<{ name: string; addedAt: string }>> {
      return [{ name: credentialName, addedAt: stored.addedAt }];
    },
    async has(name: string): Promise<boolean> {
      return name === credentialName;
    },
  };
}

/**
 * @brief Fetches available models from the given provider for onboarding.
 * @param primaryProvider - Provider id (ollama, groq, gemini, huggingface, openrouter)
 * @param apiKey - API key for cloud providers; omitted for Ollama
 * @returns List of ModelInfo, or empty array on error / no key
 */
async function fetchModelsForOnboarding(
  primaryProvider: "ollama" | "groq" | "gemini" | "huggingface" | "openrouter",
  apiKey?: string,
): Promise<ModelInfo[]> {
  const http = createRealHttpClient();
  const logger = createLogger({ level: "warn", write: () => {} });
  const credentialName = `${primaryProvider}-api-key`;

  try {
    if (primaryProvider === "ollama") {
      const provider = createOllamaProvider({
        http,
        logger,
        baseUrl: "http://localhost:11434",
      });
      return await provider.listModels();
    }
    if (!apiKey || !apiKey.trim()) return [];
    const credentials = createMemoryCredentialStore(
      credentialName,
      apiKey.trim(),
    );

    if (primaryProvider === "groq") {
      const provider = createGroqProvider({
        http,
        credentials,
        logger,
        credentialName,
      });
      return await provider.listModels();
    }
    if (primaryProvider === "gemini") {
      const provider = createGeminiProvider({
        http,
        credentials,
        logger,
        credentialName,
      });
      return await provider.listModels();
    }
    if (primaryProvider === "huggingface") {
      const provider = createHuggingFaceProvider({
        http,
        credentials,
        logger,
        credentialName,
      });
      return await provider.listModels();
    }
    if (primaryProvider === "openrouter") {
      const provider = createOpenRouterProvider({
        http,
        credentials,
        logger,
        credentialName,
      });
      return await provider.listModels();
    }
  } catch {
    // Return empty list on any error (network, auth, etc.)
  }
  return [];
}

/**
 * @brief Creates a readline interface for interactive stdin input.
 * @returns readline.Interface and a readLine async function
 */
function createReadlineInterface() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const lineQueue: string[] = [];
  let waitingResolve: ((value: string | null) => void) | null = null;
  let closed = false;

  rl.on("line", (line) => {
    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });

  rl.on("close", () => {
    closed = true;
    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve(null);
    }
  });

  async function readLine(): Promise<string | null> {
    if (lineQueue.length > 0) {
      return lineQueue.shift()!;
    }
    if (closed) return null;
    return new Promise<string | null>((resolve) => {
      waitingResolve = resolve;
    });
  }

  return { rl, readLine };
}

/**
 * @brief Prompts the user for input and returns their response.
 * @param prompt - The prompt text to display
 * @returns The user's input string
 */
async function promptUser(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const { readLine, rl } = createReadlineInterface();
  const line = await readLine();
  rl.close();
  return line ?? "";
}

// ─── Command: chat ─────────────────────────────────────────────────

/**
 * @brief Starts interactive CLI chat mode.
 * @note Creates the full app, sets up a CLI channel, and runs a REPL loop.
 */
async function runChat(): Promise<void> {
  console.log("Starting Maia interactive chat...\n");

  let app;
  try {
    app = await createApp();
  } catch (err) {
    console.error(
      "Failed to start Maia:",
      err instanceof Error ? err.message : String(err),
    );
    console.error(
      "\nHave you run 'maia onboard' yet? Check your config and .env file.",
    );
    process.exit(1);
  }

  const ctx = app.getContext();
  const runtime = app.getRuntime();

  const { rl, readLine } = createReadlineInterface();

  console.log(
    `\n${ctx.config.identity.emoji} ${ctx.config.identity.name} is ready!`,
  );
  console.log(
    "Type your message, or /quit to exit, /private to toggle privacy mode.\n",
  );

  // REPL loop -- reads input, sends through runtime, prints response
  while (true) {
    process.stdout.write("You: ");
    const input = await readLine();

    if (input === null || input === "/quit") {
      console.log("\nGoodbye!");
      break;
    }

    if (input.trim() === "") continue;

    if (input === "/private") {
      console.log(
        "Privacy mode toggled. (Privacy features are active per session.)",
      );
      continue;
    }

    if (input === "/help") {
      console.log(`
Commands:
  /quit     - Exit chat
  /private  - Toggle privacy mode
  /help     - Show this help
`);
      continue;
    }

    // Build an inbound message and send through the runtime
    const message = {
      id: ctx.crypto.randomUUID(),
      channelId: "cli",
      senderId: "user",
      content: input,
      timestamp: ctx.clock.timestamp(),
      isGroup: false,
    };

    try {
      const result = await runtime.handleMessage(message);
      console.log(`\n${ctx.config.identity.name}: ${result.content}\n`);
    } catch (err) {
      console.error(
        `\nError processing message: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        "The LLM provider may be unreachable. Check your provider configuration.\n",
      );
    }
  }

  rl.close();
  await app.stop();
}

// ─── Command: start ────────────────────────────────────────────────

/**
 * @brief Starts the full Maia gateway server with all channels and watchdog.
 */
async function runStart(): Promise<void> {
  console.log("Starting Maia gateway server...\n");

  const getOnAgentCreatedRef = {
    current: null as (() => (subAgent: SubAgent) => void) | null,
  };
  const taskMonitorRef = {
    current: null as TaskMonitor | null,
  };
  const getQueueStatusSummaryRef = {
    current: null as (() => string) | null,
  };
  const getOnWidgetReviewRequestRef = {
    current: null as ((request: WidgetReviewRequest) => void) | null,
  };

  let app;
  try {
    app = await createApp({
      getOnAgentCreatedRef,
      taskMonitorRef,
      getQueueStatusSummaryRef,
      getOnWidgetReviewRequestRef,
    });
  } catch (err) {
    console.error(
      "Failed to start Maia:",
      err instanceof Error ? err.message : String(err),
    );
    console.error(
      "\nHave you run 'maia onboard' yet? Check your config and .env file.",
    );
    process.exit(1);
  }

  const ctx = app.getContext();
  const runtime = app.getRuntime();
  const providerRegistry = app.getProviderRegistry();

  // Bootstrap workspace if needed
  const bootstrap = createBootstrap(ctx, ctx.config.workspace.path);
  if (await bootstrap.isNeeded()) {
    await bootstrap.initializeWorkspace();
    await bootstrap.complete();
    ctx.logger.info("Workspace bootstrapped");
  }

  // MCP bridge: connect to configured MCP servers and register their tools on Maia's registry
  if (ctx.config.mcp?.servers?.length) {
    for (const server of ctx.config.mcp.servers) {
      const mcpTools = await createMCPBridgeTools({ logger: ctx.logger, server });
      for (const t of mcpTools) {
        runtime.getToolRegistry().register(t);
      }
    }
  }

  // Set up gateway
  const router = createRouter({ logger: ctx.logger });
  const authMiddleware = createAuthMiddleware(ctx);
  const rateLimitMiddleware = createRateLimitMiddleware(ctx);
  const corsMiddleware = createCorsMiddleware({
    allowedOrigins: ctx.config.gateway.cors.origins,
    logger: ctx.logger,
  });
  const errorHandler = createErrorHandler({ logger: ctx.logger });

  // Forward reference for orchestrator (used by WS handler for activity and progress DM)
  type OrchestratorRef = { recordUserActivity(): void; sendDmToUser(senderId: string, senderName: string, content: string, threadId?: string): Promise<void> };
  let orchestratorRef: OrchestratorRef | null = null;

  // ── Thread service ──────────────────────────────────────────────
  const threadService = createThreadService({
    db: ctx.db,
    crypto: ctx.crypto,
    clock: ctx.clock,
    logger: ctx.logger,
  });

  const approvedSnippetsRepo = createApprovedSnippetsRepository({
    db: ctx.db,
    crypto: ctx.crypto,
    logger: ctx.logger,
  });
  const agentCreationRequestsRepo = createAgentCreationRequestsRepository({
    db: ctx.db,
    logger: ctx.logger,
  });
  const mcpServerProposalsRepo = createMcpServerProposalsRepository({
    db: ctx.db,
    logger: ctx.logger,
  });
  const widgetReviewRequestsRepo = createWidgetReviewRequestsRepository({
    db: ctx.db,
    logger: ctx.logger,
  });
  const approvedDashboardWidgetsRepo = createApprovedDashboardWidgetsRepository({
    db: ctx.db,
    logger: ctx.logger,
  });

  /** Pending flagged-agent approval requests keyed by approval request id; only user (approval_response) can approve. */
  const pendingFlaggedAgentApprovals = new Map<
    string,
    { agentId: string; agentName: string; snippet: string; reason: string }
  >();

  // ── Priority LLM Queue (sync queue + manager with workers) ─────────
  const queuePersistPath = path.join(app.getDataDir(), "queue.json");
  const priorityQueue = createQueueManager({
    maxQueueDepth: 100,
    clock: ctx.clock,
    logger: ctx.logger,
    persistPath: queuePersistPath,
    fs: app.getRawFs(),
  });
  priorityQueue.registerHandler("handleUserChat", async (args) => {
    return runtime.handleMessage(args.message as InboundMessage) as Promise<HandleMessageResult>;
  });
  // Inject queue status into Maia's LLM context only when she's the brain (user chat, high-level reasoning)
  getQueueStatusSummaryRef.current = () => {
    const s = priorityQueue.getQueueStatusSummary();
    const lines: string[] = [];
    for (const [name, data] of Object.entries(s)) {
      lines.push(`${name}: ${data.pending} pending, ${data.running.length} running`);
      if (data.running.length > 0) {
        lines.push(`  Running: ${data.running.map((r: { jobId: string; action: string }) => `${r.action} (${r.jobId})`).join("; ")}`);
      }
    }
    return lines.join("\n");
  };

  let onAgentCreationRequest: (request: AgentCreationRequest) => void = () => {};
  let onMcpProposalForUserApproval: (proposal: McpServerProposal) => void = () => {};

  type ApprovalPayload = {
    kind: string;
    decision: string;
    feedback?: string;
    proposalId?: string;
    agentId?: string;
    approvalRequestId?: string;
    requestId?: string;
  };

  let approvalResponseHandler: (
    connectionId: string,
    senderId: string,
    payload: ApprovalPayload
  ) => Promise<void> = async () => {};

  // Set up WebSocket handler
  const wsHandler = createWSHandler({
    logger: ctx.logger,
    events: ctx.events,
    onApprovalResponse: (connId, senderId, payload) => approvalResponseHandler(connId, senderId, payload),
    onChatMessage: async (_connectionId, senderId, content) => {
      const message = {
        id: ctx.crypto.randomUUID(),
        channelId: "webchat",
        senderId,
        content,
        timestamp: ctx.clock.timestamp(),
        isGroup: false,
      };

      // User chat goes through priority queue at highest priority
      const jobId = priorityQueue.enqueue("handleUserChat", { message }, "user", "user");
      const result = (await priorityQueue.waitForJobResult(jobId)) as HandleMessageResult;

      if (result.securityFlagged) {
        // Flag applies to the conversation partner (sender). Here the sender is the user; we audit and push approval for maia (responder) to allowlist the snippet.
        const { reason, snippet } = result.securityFlagged;
        const approved = await approvedSnippetsRepo.isApproved("maia", snippet);
        if (!approved) {
          await ctx.auditLog.log("INLINE_SECURITY_FLAG", {
            flaggedPartyId: senderId,
            reportedBy: "maia",
            reason,
            snippet: snippet.slice(0, 200),
            timestamp: ctx.clock.timestamp(),
          });
          pushFlaggedAgentApproval("maia", "Maia", reason, snippet);
        }
      }

      if (result.progressReport && orchestratorRef) {
        const { status, summary } = result.progressReport;
        await orchestratorRef.sendDmToUser(
          "maia",
          "Maia",
          `Progress: [${status}] ${summary}`
        );
      }

      return {
        content: result.content,
        remembered: result.remembered,
        securityFlagged: result.securityFlagged,
        progressReport: result.progressReport,
        responderId: "maia",
      };
    },
    onThreadMessage: async (_connectionId, senderId, threadId, content) => {
      // Add the user's message to the thread
      await threadService.addMessage(threadId, senderId, "user", content);
      return { content: "Message added to thread." };
    },
    onUserActivity: () => {
      // Will be wired to orchestrator.recordUserActivity() after orchestrator is created
      orchestratorRef?.recordUserActivity();
    },
  });

  const gateway = createGatewayServer({
    ctx,
    router,
    authMiddleware,
    rateLimitMiddleware,
    corsMiddleware,
    errorHandler,
    wsHandler,
  });

  // Register API routes (onChat runs after server start so pushFlaggedAgentApproval and orchestratorRef exist when used)
  registerApiRoutes(gateway, {
    startTime: Date.now(),
    onChat: async (message, senderId) => {
      const inbound = {
        id: ctx.crypto.randomUUID(),
        channelId: "api",
        senderId,
        content: message,
        timestamp: ctx.clock.timestamp(),
        isGroup: false,
      };
      const result = await runtime.handleMessage(inbound);
      if (result.securityFlagged) {
        // Flag applies to the conversation partner (sender). Here the sender is the API caller; we audit and push approval for maia to allowlist the snippet.
        const { reason, snippet } = result.securityFlagged;
        const approved = await approvedSnippetsRepo.isApproved("maia", snippet);
        if (!approved) {
          await ctx.auditLog.log("INLINE_SECURITY_FLAG", {
            flaggedPartyId: senderId,
            reportedBy: "maia",
            reason,
            snippet: snippet.slice(0, 200),
            timestamp: ctx.clock.timestamp(),
          });
          pushFlaggedAgentApproval("maia", "Maia", reason, snippet);
        }
      }
      if (result.progressReport && orchestratorRef) {
        const { status, summary } = result.progressReport;
        await orchestratorRef.sendDmToUser(
          "maia",
          "Maia",
          `Progress: [${status}] ${summary}`
        );
      }
      return {
        content: result.content,
        remembered: result.remembered,
        securityFlagged: result.securityFlagged,
        progressReport: result.progressReport,
        responderId: "maia",
      };
    },
    providerHealthCheck: async () => {
      const status = await providerRegistry.healthStatus();
      const result: Record<string, boolean> = {};
      for (const [id, healthy] of status) {
        result[id] = healthy;
      }
      return result;
    },
  });

  // Ref set after we have agentRegistry/threadService; used to send initial state on WS connect
  const onWsConnectRef: { current: OnWsConnect | undefined } = { current: undefined };

  // Start Bun HTTP server
  const bunServer = startBunServer({
    config: ctx.config,
    gateway,
    logger: ctx.logger,
    getOnWsConnect: () => onWsConnectRef.current,
  });

  ctx.events.on("agentCreated", async (data: Record<string, unknown>) => {
    const agentId = data.agentId as string | undefined;
    if (agentId) {
      bunServer.wsBroadcast(JSON.stringify({ type: "agent_created", agentId }));
    }
  });

  /** Push a flagged-agent approval request to the dashboard; only user (approval_response) can approve. */
  function pushFlaggedAgentApproval(
    agentId: string,
    agentName: string,
    reason: string,
    snippet: string
  ): void {
    const id = ctx.crypto.randomUUID();
    pendingFlaggedAgentApprovals.set(id, { agentId, agentName, snippet, reason });
    bunServer.wsBroadcast(
      JSON.stringify({
        type: "approval_request",
        id,
        kind: "flagged_agent",
        agentId,
        agentName,
        reason,
        snippet,
      })
    );
  }

  onAgentCreationRequest = (request) => {
    bunServer.wsBroadcast(
      JSON.stringify({
        type: "approval_request",
        id: ctx.crypto.randomUUID(),
        kind: "agent_creation_request",
        requestId: request.id,
        agentId: request.proposedConfig.id,
        summary: `Agent creation requested by ${request.requestingAgentId}: ${request.proposedConfig.id}`,
      })
    );
  };

  onMcpProposalForUserApproval = (proposal: McpServerProposal) => {
    bunServer.wsBroadcast(
      JSON.stringify({
        type: "approval_request",
        id: ctx.crypto.randomUUID(),
        kind: "mcp_server_proposal",
        requestId: proposal.id,
        summary: `MCP server "${proposal.name}" proposed by ${proposal.proposingAgentId}: ${proposal.description ?? proposal.sandboxPath}`,
      })
    );
  };

  getOnWidgetReviewRequestRef.current = (request: WidgetReviewRequest) => {
    bunServer.wsBroadcast(
      JSON.stringify({
        type: "approval_request",
        id: ctx.crypto.randomUUID(),
        kind: "widget_review_request",
        requestId: request.id,
        requestingAgentId: request.requestingAgentId,
        widgetId: request.widgetId,
        name: request.name,
        html: request.html,
        css: request.css,
        js: request.js,
        summary: `Widget "${request.widgetId}" submitted by ${request.requestingAgentId} for security review`,
      })
    );
  };

  // Register shutdown hook for the server
  ctx.shutdown.register(
    "bun-server",
    async () => {
      bunServer.stop();
    },
    5,
  );

  // Start watchdog if enabled
  if (ctx.config.watchdog.enabled) {
    const threatDetector = createThreatDetector({
      clock: ctx.clock,
      windowDurationMs: ctx.config.watchdog.threatWindow.durationMs,
      bruteForceThreshold: ctx.config.watchdog.threatWindow.bruteForceThreshold,
      injectionThreshold: ctx.config.watchdog.threatWindow.injectionThreshold,
    });
    const alerter = createAlerter({
      channels: ctx.config.watchdog.alertChannels,
      logger: ctx.logger,
      shutdownCoordinator: ctx.shutdown,
      autoShutdown: ctx.config.watchdog.autoShutdown,
    });
    const emergencyShutdown = createEmergencyShutdown({
      shutdownCoordinator: ctx.shutdown,
      auditLog: ctx.auditLog,
      logger: ctx.logger,
    });
    const auditMonitor = createAuditMonitor({
      auditLog: ctx.auditLog,
      threatDetector,
      alerter,
      clock: ctx.clock,
      logger: ctx.logger,
      pollIntervalMs: ctx.config.watchdog.healthCheckIntervalMs,
    });

    const watchdog = createWatchdogDaemon({
      ctx,
      threatDetector,
      alerter,
      auditMonitor,
      emergencyShutdown,
      healthChecks: [],
      healthCheckIntervalMs: ctx.config.watchdog.healthCheckIntervalMs,
    });

    await watchdog.start();
    ctx.shutdown.register(
      "watchdog",
      async () => {
        await watchdog.stop();
      },
      3,
    );

    ctx.logger.info("Watchdog daemon started");
  }

  // ── Agent loading + scheduler ────────────────────────────────────

  const agentRegistry = app.getAgentRegistry();
  const activeAgents = app.getActiveAgents();
  const llmCallsRepo = app.getLlmCallsRepository();
  const logLlmCall = async (
    call: Omit<import("./llm-calls.js").CreateLlmCallInput, "id">
  ): Promise<void> => {
    await llmCallsRepo.create({ ...call, id: ctx.crypto.randomUUID() });
  };

  let createAndActivateAgent: (config: AgentConfig) => SubAgent;

  const sharedAgentDeps: SharedAgentDeps & {
    agentRegistry?: typeof agentRegistry;
    createRuntime?: (config: AgentConfig) => SubAgent;
    activeAgents?: Map<string, SubAgent>;
    creationRequestsRepo?: AgentCreationRequestsRepository;
    onAgentCreationRequest?: (request: AgentCreationRequest) => void;
  } = {
    db: ctx.db,
    crypto: ctx.crypto,
    http: ctx.http,
    clock: ctx.clock,
    auditLog: ctx.auditLog,
    events: ctx.events,
    logger: ctx.logger,
    config: ctx.config,
    providerRegistry,
    rawFs: app.getRawFs(),
    agentRegistry,
    creationRequestsRepo: agentCreationRequestsRepo,
    onAgentCreationRequest: (req) => onAgentCreationRequest(req),
    logLlmCall,
  };

  createAndActivateAgent = (config: AgentConfig) => {
    const agentWorkspace = agentRegistry.agentWorkspacePath(config.id);
    const subAgent = createSubAgentRuntime(config, agentWorkspace, sharedAgentDeps);
    activeAgents.set(config.id, subAgent);
    return subAgent;
  };
  sharedAgentDeps.createRuntime = createAndActivateAgent;
  sharedAgentDeps.activeAgents = activeAgents;

  // Load all existing agents and create their runtimes
  try {
    const existingAgents = await agentRegistry.list();
    for (const agentConfig of existingAgents) {
      if (agentConfig.active === false) continue;
      try {
        const agentWorkspace = agentRegistry.agentWorkspacePath(agentConfig.id);
        const subAgent = createSubAgentRuntime(agentConfig, agentWorkspace, sharedAgentDeps);
        activeAgents.set(agentConfig.id, subAgent);
        if (
          sharedAgentDeps.creationRequestsRepo &&
          sharedAgentDeps.onAgentCreationRequest
        ) {
          subAgent.runtime.getToolRegistry().register(
            createAgentCreateTool({
              registry: agentRegistry,
              logger: ctx.logger,
              createRuntime: createAndActivateAgent,
              activeAgents,
              crypto: ctx.crypto,
              resolveAgentId: () => agentConfig.id,
              creationRequestsRepo: agentCreationRequestsRepo,
              onAgentCreationRequest,
            })
          );
        }
        ctx.logger.info("Agent loaded", {
          id: agentConfig.id,
          name: agentConfig.name,
        });
      } catch (err) {
        ctx.logger.warn("Failed to load agent", {
          id: agentConfig.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (existingAgents.length > 0) {
      ctx.logger.info("Agents loaded", {
        count: activeAgents.size,
        total: existingAgents.length,
      });
    }
  } catch (err) {
    ctx.logger.warn("Failed to load agents", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Register queue action handlers that need activeAgents; then start workers and load persisted items
  priorityQueue.registerHandler("handleTaskMonitorMessage", async (args) => {
    const agentId = args.agentId as string;
    if (agentId === "maia") {
      return runtime.handleMessage(args.message as InboundMessage) as Promise<HandleMessageResult>;
    }
    const subAgent = activeAgents.get(agentId);
    if (!subAgent) throw new Error(`Agent not found: ${agentId}`);
    return subAgent.runtime.handleMessage(args.message as InboundMessage) as Promise<HandleMessageResult>;
  });
  priorityQueue.registerHandler("handleAgentCheckin", async (args) => {
    const agentId = args.agentId as string;
    const subAgent = activeAgents.get(agentId);
    if (!subAgent) throw new Error(`Agent not found: ${agentId}`);
    return subAgent.runtime.handleMessage(args.message as InboundMessage) as Promise<HandleMessageResult>;
  });
  priorityQueue.registerHandler("handleAgentToAgentChat", async (args) => {
    const toAgentId = args.toAgentId as string;
    const subAgent = activeAgents.get(toAgentId);
    if (!subAgent) throw new Error(`Agent not found: ${toAgentId}`);
    return subAgent.runtime.handleMessage(args.message as InboundMessage) as Promise<HandleMessageResult>;
  });
  priorityQueue.registerHandler("handleWelcomeMessage", async (args) => {
    const agentId = args.agentId as string;
    const subAgent = activeAgents.get(agentId);
    if (!subAgent) throw new Error(`Agent not found: ${agentId}`);
    return subAgent.runtime.handleMessage(args.message as InboundMessage) as Promise<HandleMessageResult>;
  });
  priorityQueue.registerHandler("handleMaiaBrainRun", async () => {
    const message: InboundMessage = {
      id: ctx.crypto.randomUUID(),
      channelId: "maia:brain",
      senderId: "system",
      content:
        "Review your goals (see GOALS.md) and your task list (task_manage list). What short-term goal should you work on? Use task_manage to schedule yourself if needed.",
      timestamp: ctx.clock.timestamp(),
      isGroup: false,
    };
    return runtime.handleMessage(message) as Promise<HandleMessageResult>;
  });
  priorityQueue.startWorkers();
  await priorityQueue.loadFromFile();

  approvalResponseHandler = async (
    _connectionId: string,
    _senderId: string,
    payload: {
      kind: string;
      decision: string;
      feedback?: string;
      proposalId?: string;
      agentId?: string;
      approvalRequestId?: string;
    }
  ) => {
    if (payload.kind === "agent_creation_request" && (payload as ApprovalPayload).requestId) {
      const requestId = (payload as ApprovalPayload).requestId!;
      const request = await agentCreationRequestsRepo.getById(requestId);
      if (!request || request.status !== "pending") return;
      if (payload.decision === "approve") {
        const p = request.proposedConfig;
        const defaultModel = { provider: ctx.config.provider.primary, model: ctx.config.provider.model };
        const config: AgentConfig = {
          id: p.id,
          name: PLACEHOLDER_NAME,
          emoji: p.emoji ?? "🤖",
          personality: PLACEHOLDER_SOUL,
          createdBy: request.requestingAgentId,
          schedule: p.schedule ?? "",
          tools: p.tools ?? ["memory_search", "memory_store"],
          model: p.model ?? defaultModel,
          instructions: p.instructions,
        };
        const registered = await agentRegistry.register(config);
        const subAgent = createAndActivateAgent(registered);
        activeAgents.set(config.id, subAgent);
        getOnAgentCreatedRef.current?.()(subAgent);
        await ctx.events.emit("agentCreated", { agentId: config.id });
        await agentCreationRequestsRepo.updateStatus(requestId, "approved");
        const creatorMemoryStore = createMemoryStore({
          db: ctx.db,
          crypto: ctx.crypto,
          logger: ctx.logger,
          agentId: request.requestingAgentId,
        });
        await creatorMemoryStore.store({
          text: `I requested creation of agent ${config.id}. I can chat with them using chat_with_agent.`,
          category: "fact",
          importance: 0.5,
        });
        await orchestrator.agentToAgentChat(
          "maia",
          request.requestingAgentId,
          `Your agent creation request for **${config.id}** was approved. They are now active. You can chat with them using chat_with_agent.`
        );
        ctx.logger.info("Agent creation request approved", {
          requestId,
          agentId: config.id,
          requestingAgentId: request.requestingAgentId,
        });
      } else {
        await agentCreationRequestsRepo.updateStatus(requestId, "denied");
        await orchestrator.agentToAgentChat(
          "maia",
          request.requestingAgentId,
          `Your agent creation request for **${request.proposedConfig.id}** was denied.`
        );
        ctx.logger.info("Agent creation request denied", {
          requestId,
          requestingAgentId: request.requestingAgentId,
        });
      }
    } else if (payload.kind === "mcp_server_proposal" && (payload as ApprovalPayload).requestId) {
      const proposalId = (payload as ApprovalPayload).requestId!;
      const proposal = await mcpServerProposalsRepo.getById(proposalId);
      if (!proposal || proposal.status !== "pending_user") return;
      if (payload.decision === "approve") {
        await mcpServerProposalsRepo.updateStatus(proposalId, "user_approved");
        const mcpApprovedDir = path.join(app.getDataDir(), "mcp-approved");
        const snippetPath = path.join(mcpApprovedDir, `${proposal.name.replace(/[^a-z0-9-_]/gi, "_")}.yml`);
        const snippet = `# Add this to your Docker MCP config (e.g. gordon-mcp.yml or --additional-config)
# MCP server: ${proposal.name}
# Proposed by agent: ${proposal.proposingAgentId}
# Path: ${proposal.sandboxPath}
services:
  ${proposal.name.replace(/[^a-z0-9-_]/gi, "_")}:
    build: ${proposal.sandboxPath}
    # Or use image: ${proposal.imageRef ?? "<image-ref>"}
`;
        try {
          const rawFs = app.getRawFs();
          if (!(await rawFs.exists(mcpApprovedDir))) {
            await rawFs.mkdir(mcpApprovedDir);
          }
          await rawFs.writeFile(snippetPath, snippet);
        } catch (err) {
          ctx.logger.warn("Failed to write MCP snippet", { path: snippetPath, error: err instanceof Error ? err.message : String(err) });
        }
        await orchestrator.agentToAgentChat(
          "maia",
          proposal.proposingAgentId,
          `Your MCP server **${proposal.name}** was approved. A config snippet was written to \`${snippetPath}\`. Add it to your Docker MCP setup (e.g. --additional-config) to use it.`
        );
        ctx.logger.info("MCP server proposal approved", { proposalId, name: proposal.name, proposingAgentId: proposal.proposingAgentId });
      } else {
        await mcpServerProposalsRepo.updateStatus(proposalId, "user_denied", {
          userFeedback: payload.feedback ?? undefined,
        });
        await orchestrator.agentToAgentChat(
          "maia",
          proposal.proposingAgentId,
          `Your MCP server proposal **${proposal.name}** was denied.${payload.feedback ? ` Feedback: ${payload.feedback}` : ""}`
        );
        ctx.logger.info("MCP server proposal denied", { proposalId, proposingAgentId: proposal.proposingAgentId });
      }
    } else if (payload.kind === "widget_review_request" && (payload as ApprovalPayload).requestId) {
      const requestId = (payload as ApprovalPayload).requestId!;
      const request = await widgetReviewRequestsRepo.getById(requestId);
      if (!request || request.status !== "pending") return;
      if (payload.decision === "approve") {
        const approvedId = ctx.crypto.randomUUID();
        await approvedDashboardWidgetsRepo.create({
          id: approvedId,
          agentId: request.requestingAgentId,
          widgetId: request.widgetId,
          name: request.name,
          html: request.html,
          css: request.css,
          js: request.js,
        });
        await widgetReviewRequestsRepo.updateStatus(requestId, "approved");
        if (orchestratorRef) {
          await orchestrator.agentToAgentChat(
            "maia",
            request.requestingAgentId,
            `Your dashboard widget **${request.widgetId}** was approved. It will appear on your dashboard.`
          );
        }
        ctx.logger.info("Widget review request approved", {
          requestId,
          requestingAgentId: request.requestingAgentId,
          widgetId: request.widgetId,
        });
        bunServer.wsBroadcast(
          JSON.stringify({ type: "widget_approved", agentId: request.requestingAgentId })
        );
      } else {
        await widgetReviewRequestsRepo.updateStatus(requestId, "denied");
        if (orchestratorRef) {
          await orchestrator.agentToAgentChat(
            "maia",
            request.requestingAgentId,
            `Your dashboard widget **${request.widgetId}** was denied.${payload.feedback ? ` Feedback: ${payload.feedback}` : ""}`
          );
        }
        ctx.logger.info("Widget review request denied", {
          requestId,
          requestingAgentId: request.requestingAgentId,
          widgetId: request.widgetId,
        });
      }
    } else if (payload.kind === "flagged_agent" && payload.agentId) {
      const agentId = payload.agentId;
      const pending = payload.approvalRequestId
        ? pendingFlaggedAgentApprovals.get(payload.approvalRequestId)
        : undefined;
      if (pending && (payload.decision === "restart_with_warning" || payload.decision === "restart")) {
        await approvedSnippetsRepo.add(pending.agentId, pending.snippet);
        pendingFlaggedAgentApprovals.delete(payload.approvalRequestId!);
        ctx.logger.info("User approved security snippet for agent", {
          agentId: pending.agentId,
        });
      }
      if (payload.decision === "restart_with_warning" || payload.decision === "restart") {
        const config = await agentRegistry.get(agentId);
        if (config) {
          await agentRegistry.update(agentId, { active: true });
          const agentWorkspace = agentRegistry.agentWorkspacePath(agentId);
          const subAgent = createSubAgentRuntime(config, agentWorkspace, sharedAgentDeps);
          activeAgents.set(agentId, subAgent);
          ctx.logger.info("Agent restarted after flagged", { agentId });
        }
      } else if (payload.decision === "remove") {
        await agentRegistry.remove(agentId);
        ctx.logger.info("Agent removed by user after flagged", { agentId });
      }
      if (payload.approvalRequestId) {
        pendingFlaggedAgentApprovals.delete(payload.approvalRequestId);
      }
    }
  };

  // Start the scheduler with agent task dispatch
  const scheduler = createScheduler({
    fs: ctx.fs,
    clock: ctx.clock,
    schedulerPath: `${ctx.config.workspace.path}/data/scheduler.json`,
    logger: ctx.logger,
    checkIntervalMs: ctx.config.scheduler.checkIntervalMs,
  });

  // Register schedules from loaded agents
  for (const [agentId, subAgent] of activeAgents) {
    if (subAgent.config.schedule) {
      await scheduler.add({
        schedule: subAgent.config.schedule,
        prompt: `Execute your scheduled task as ${subAgent.config.name}.`,
        channel: `agent:${agentId}`,
        agentId,
      });
    }
  }

  scheduler.start(async (task) => {
    const taskWithAgent = task as typeof task & { agentId?: string };
    const agentId =
      taskWithAgent.agentId ?? taskWithAgent.channel?.replace("agent:", "");
    if (!agentId) {
      ctx.logger.warn("Scheduled task has no agent", { taskId: task.id });
      return;
    }
    const subAgent = activeAgents.get(agentId);
    if (!subAgent) {
      ctx.logger.warn("Scheduled task agent not found", {
        taskId: task.id,
        agentId,
      });
      return;
    }

    ctx.logger.info("Executing scheduled task", { taskId: task.id, agentId });
    try {
      const message = {
        id: ctx.crypto.randomUUID(),
        channelId: `scheduler:${agentId}`,
        senderId: "scheduler",
        content: task.prompt,
        timestamp: ctx.clock.timestamp(),
        isGroup: false,
      };
      const result = await subAgent.runtime.handleMessage(message);
      if (result.securityFlagged) {
        // Flag applies to the conversation partner (sender), not the responder. Sender here is "scheduler".
        const { reason, snippet } = result.securityFlagged;
        const flaggedPartyId = message.senderId;
        await ctx.auditLog.log("INLINE_SECURITY_FLAG", {
          flaggedPartyId,
          reportedBy: agentId,
          reason,
          snippet: snippet.slice(0, 200),
          timestamp: ctx.clock.timestamp(),
        });
        if (orchestratorRef) {
          await orchestratorRef.sendDmToUser(
            "maia",
            "Maia",
            `Agent **${subAgent.config.name}** (${agentId}) reported a concern about the scheduled task prompt: ${reason}.`
          );
        }
        // Do not stop the agent; the flag applies to the sender (scheduler), not the responder.
      }
      if (result.progressReport && orchestratorRef) {
        const { status, summary } = result.progressReport;
        await orchestratorRef.sendDmToUser(
          agentId,
          subAgent.config.name,
          `Progress: [${status}] ${summary}`
        );
      }
      await ctx.events.emit("agentTaskCompleted", { agentId, taskId: task.id });
    } catch (err) {
      ctx.logger.warn("Scheduled task execution failed", {
        taskId: task.id,
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      await ctx.events.emit("agentError", {
        agentId,
        taskId: task.id,
        error: String(err),
      });
    }
  });

  ctx.shutdown.register(
    "scheduler",
    async () => {
      scheduler.stop();
    },
    4,
  );

  // ── Task Monitor (tasks.json scanner) ────────────────────────
  const taskMonitor = createTaskMonitor({
    fs: ctx.fs,
    clock: ctx.clock,
    crypto: ctx.crypto,
    logger: ctx.logger,
    getAgentWorkspaces: () => {
      const map = new Map<string, string>();
      map.set("maia", ctx.config.workspace.path);
      for (const [agentId] of activeAgents) {
        map.set(agentId, agentRegistry.agentWorkspacePath(agentId));
      }
      return map;
    },
  });

  taskMonitorRef.current = taskMonitor;
  taskMonitor.start(async (agentId, task) => {
    const subAgent = agentId === "maia" ? null : activeAgents.get(agentId);
    if (agentId !== "maia" && !subAgent) return;

    ctx.logger.info("Task monitor firing task", { agentId, taskId: task.id });
    const message: InboundMessage = {
      id: ctx.crypto.randomUUID(),
      channelId: `task:${agentId}`,
      senderId: "task-monitor",
      content: task.prompt,
      timestamp: ctx.clock.timestamp(),
      isGroup: false,
    };
    const jobId = priorityQueue.enqueue("handleTaskMonitorMessage", { message, agentId }, "agent", agentId);
    try {
      const result = (await priorityQueue.waitForJobResult(jobId)) as HandleMessageResult;
      if (result.securityFlagged) {
        const { reason, snippet } = result.securityFlagged;
        const flaggedPartyId = message.senderId;
        await ctx.auditLog.log("INLINE_SECURITY_FLAG", {
          flaggedPartyId,
          reportedBy: agentId,
          reason,
          snippet: snippet.slice(0, 200),
          timestamp: ctx.clock.timestamp(),
        });
        if (orchestratorRef) {
          const name = agentId === "maia" ? "Maia" : subAgent!.config.name;
          await orchestratorRef.sendDmToUser(
            "maia",
            "Maia",
            `Agent **${name}** (${agentId}) reported a concern about the task prompt: ${reason}.`
          );
        }
      }
      if (result.progressReport && orchestratorRef) {
        const { status, summary } = result.progressReport;
        const name = agentId === "maia" ? "Maia" : subAgent!.config.name;
        await orchestratorRef.sendDmToUser(
          agentId,
          name,
          `Progress: [${status}] ${summary}`
        );
      }
    } catch (err) {
      ctx.logger.warn("Task monitor job failed", { agentId, taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Register task_manage for Maia so she can schedule herself (goals, short-term tasks)
  runtime.getToolRegistry().register(
    createTaskManageTool({
      logger: ctx.logger,
      taskMonitor,
      resolveAgentId: () => "maia",
    })
  );

  ctx.shutdown.register(
    "task-monitor",
    async () => {
      taskMonitor.stop();
    },
    4,
  );

  // ── Telegram channel (optional) ───────────────────────────────────
  type TelegramChannelInstance = ReturnType<typeof createTelegramChannel>;
  let telegramChannel: TelegramChannelInstance | null = null;
  let forwardDmToUser: ((content: string) => Promise<void>) | undefined;

  if (ctx.config.channels.telegram.enabled) {
    const telegramCredName =
      ctx.config.channels.telegram.credentialName ?? "telegram-bot-token";
    const telegramUserChatId = ctx.config.channels.telegram.userChatId;

    telegramChannel = createTelegramChannel({
      logger: ctx.logger,
      http: ctx.http,
      credentials: ctx.credentials,
      formatter: createMessageFormatter("telegram"),
      credentialName: telegramCredName,
    });

    try {
      await telegramChannel.initialize({ enabled: true });
    } catch (err) {
      ctx.logger.error("Telegram channel failed to initialize", {
        error: err instanceof Error ? err.message : String(err),
      });
      telegramChannel = null;
    }

    if (telegramChannel) {
      telegramChannel.onMessage(async (message: InboundMessage) => {
        if (telegramUserChatId) {
          const senderId = message.senderId;
          const chatIdFromMeta = message.metadata?.chatId as number | undefined;
          const allowed =
            String(chatIdFromMeta ?? senderId) === telegramUserChatId;
          if (!allowed) {
            ctx.logger.debug("Telegram message from non-linked user, ignoring", {
              senderId,
              userChatId: telegramUserChatId,
            });
            return;
          }
        }

        const thread = await threadService.findOrCreateThread(
          "agent-dm",
          ["maia", "user"],
          "DM from Maia",
        );
        await threadService.addMessage(
          thread.id,
          "user",
          "user",
          message.content,
        );

        const inbound: InboundMessage = {
          id: message.id,
          channelId: "telegram",
          senderId: "user",
          content: message.content,
          timestamp: message.timestamp,
          isGroup: false,
          metadata: message.metadata,
        };
        const jobId = priorityQueue.enqueue(
          "handleUserChat",
          { message: inbound },
          "user",
          "user",
        );
        const result = (await priorityQueue.waitForJobResult(
          jobId,
        )) as HandleMessageResult;

        const chatId = (message.metadata?.chatId as number | undefined) ?? message.senderId;
        const ch = telegramChannel;
        if (ch) {
          await ch.send({
            channelId: "telegram",
            recipientId: String(chatId),
            content: result.content,
          });
        }

        await threadService.addMessage(
          thread.id,
          "maia",
          "maia",
          result.content,
        );
      });

      router.post("/telegram-webhook", async (req) => {
        const webhookSecret = ctx.config.channels.telegram.webhookSecret?.trim();
        if (webhookSecret) {
          const headerToken =
            req.headers["x-telegram-bot-api-secret-token"] ??
            req.headers["X-Telegram-Bot-Api-Secret-Token"] ??
            "";
          if (headerToken !== webhookSecret) {
            return {
              status: 403,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Forbidden" }),
            };
          }
        }

        let update: Record<string, unknown>;
        try {
          update = JSON.parse(req.body || "{}") as Record<string, unknown>;
        } catch {
          return {
            status: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Invalid JSON body" }),
          };
        }

        const ch = telegramChannel;
        if (ch && "injectTelegramUpdate" in ch) {
          await (ch as { injectTelegramUpdate: (u: Record<string, unknown>) => Promise<void> }).injectTelegramUpdate(update);
        }

        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ok: true }),
        };
      });

      if (telegramUserChatId) {
        const ch = telegramChannel;
        forwardDmToUser = async (content: string) => {
          if (ch) {
            await ch.send({
              channelId: "telegram",
              recipientId: telegramUserChatId,
              content,
            });
          }
        };
      }

      ctx.shutdown.register(
        "telegram-channel",
        async () => {
          await telegramChannel?.shutdown();
        },
        4,
      );
    }
  }

  // ── Agent Orchestrator ──────────────────────────────────────────
  const orchestrator = createOrchestrator({
    clock: ctx.clock,
    crypto: ctx.crypto,
    logger: ctx.logger,
    threadService,
    priorityQueue: priorityQueue as OrchestratorQueue,
    activeAgents,
    maiaRuntime: runtime,
    wsPush: (type: string, payload: Record<string, unknown>) => {
      bunServer.wsBroadcast(JSON.stringify({ type, ...payload }));
    },
    agentRegistry,
    checkInSkipIfDmWithinMs: 15 * 60 * 1000,
    approvedSnippetsRepo,
    onFlaggedAgentApprovalRequest: pushFlaggedAgentApproval,
    agentWorkspaceFs: app.getRawFs(),
    auditLog: ctx.auditLog,
    forwardDmToUser,
  });

  orchestratorRef = orchestrator;
  orchestrator.start();

  // Maia's periodic brain run: review goals and schedule self (when enabled)
  let maiaBrainTimer: ReturnType<typeof setInterval> | null = null;
  const maiaBrainIntervalMs = ctx.config.scheduler.maiaBrainIntervalMs ?? 0;
  if (maiaBrainIntervalMs > 0) {
    ctx.logger.info("Maia brain timer started", { intervalMs: maiaBrainIntervalMs });
    maiaBrainTimer = setInterval(() => {
      priorityQueue.enqueue("handleMaiaBrainRun", {}, "background", "maia");
    }, maiaBrainIntervalMs);
    ctx.shutdown.register(
      "maia-brain",
      async () => {
        if (maiaBrainTimer) {
          clearInterval(maiaBrainTimer);
          maiaBrainTimer = null;
        }
      },
      5
    );
  }

  const rawFs = app.getRawFs();

  const writeAgentWorkspaceFile = async (agentId: string, filename: string, content: string) => {
    const p = agentRegistry.agentWorkspacePath(agentId) + "/" + filename;
    await rawFs.writeFile(p, content);
  };

  const registerAgentTools = (agentId: string, subAgent: SubAgent) => {
    subAgent.runtime.getToolRegistry().register(
      createChatWithAgentTool({
        logger: ctx.logger,
        orchestrator,
        resolveAgentId: () => agentId,
      })
    );
    subAgent.runtime.getToolRegistry().register(
      createDmUserTool({
        logger: ctx.logger,
        orchestrator,
        activeAgents,
        resolveAgentId: () => agentId,
      })
    );
    subAgent.runtime.getToolRegistry().register(
      createAgentListTool({
        registry: agentRegistry,
        logger: ctx.logger,
        createRuntime: createAndActivateAgent,
        activeAgents,
        crypto: ctx.crypto,
        taskMonitor,
        resolveAgentId: () => agentId,
      })
    );
    subAgent.runtime.getToolRegistry().register(
      createSetIdentityTool({
        logger: ctx.logger,
        registry: agentRegistry,
        resolveAgentId: () => agentId,
        writeAgentWorkspaceFile,
      })
    );
    subAgent.runtime.getToolRegistry().register(
      createProposeMcpServerTool({
        logger: ctx.logger,
        crypto: ctx.crypto,
        repo: mcpServerProposalsRepo,
        registry: agentRegistry,
        resolveAgentId: () => agentId,
        onMcpProposalForUserApproval: (proposal) => onMcpProposalForUserApproval(proposal),
      })
    );
    subAgent.runtime.getToolRegistry().register(
      createSubmitWidgetForReviewTool({
        logger: ctx.logger,
        crypto: ctx.crypto,
        widgetReviewRequestsRepo,
        resolveAgentId: () => agentId,
        onWidgetReviewRequest: (req) => getOnWidgetReviewRequestRef.current?.(req),
      })
    );
    subAgent.runtime.getToolRegistry().register(
      createCheckQueueJobTool({
        logger: ctx.logger,
        getJobStatus: (jobId) => priorityQueue.getJobStatus(jobId),
      })
    );
    subAgent.runtime.getToolRegistry().register(
      createTaskManageTool({
        logger: ctx.logger,
        taskMonitor,
        resolveAgentId: () => agentId,
      })
    );
  };
  for (const [agentId, subAgent] of activeAgents) {
    registerAgentTools(agentId, subAgent);
  }
  getOnAgentCreatedRef.current = () => (subAgent: SubAgent) => {
    registerAgentTools(subAgent.config.id, subAgent);
    const welcomeContent =
      "You were just created. Use the set_identity tool to choose your name and soul (personality). They must be unique among all agents. Call set_identity with your chosen name and soul.";
    const message: InboundMessage = {
      id: ctx.crypto.randomUUID(),
      channelId: "welcome",
      senderId: "maia",
      content: welcomeContent,
      timestamp: ctx.clock.timestamp(),
      isGroup: false,
    };
    priorityQueue.enqueue("handleWelcomeMessage", { message, agentId: subAgent.config.id }, "agent", subAgent.config.id);
  };

  ctx.shutdown.register(
    "orchestrator",
    async () => {
      orchestrator.stop();
    },
    4,
  );

  // ── Dashboard API routes ─────────────────────────────────────
  registerDashboardRoutes(gateway, {
    agentRegistry,
    threadService,
    taskMonitor,
    activeAgents,
    auditLog: ctx.auditLog,
    llmCallsRepo,
    approvedDashboardWidgetsRepo,
  });

  // Send full agents + threads to each client on WebSocket connect so dashboard can avoid GET spam
  onWsConnectRef.current = async (connectionId, send) => {
    try {
      const agents = await agentRegistry.list();
      const agentsWithStatus = agents.map((a) => ({
        ...a,
        isRunning: activeAgents.has(a.id),
      }));
      const threads = await threadService.listThreads();
      send(
        JSON.stringify({
          type: "initial_state",
          agents: agentsWithStatus,
          threads,
        })
      );
    } catch (err) {
      ctx.logger.warn("Initial state send failed", {
        connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  console.log(
    `\n${ctx.config.identity.emoji} ${ctx.config.identity.name} is running!`,
  );
  console.log(`Gateway: ${bunServer.url}`);
  console.log(`WebSocket: ${bunServer.url.replace("http", "ws")}/ws`);
  if (activeAgents.size > 0) {
    console.log(`Active agents: ${activeAgents.size}`);
  }
  console.log("\nPress Ctrl+C to stop.\n");

  // Handle graceful shutdown on SIGINT/SIGTERM
  const handleShutdown = async () => {
    console.log("\nShutting down...");
    await app.stop();
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  // Keep the process alive
  await new Promise(() => {});
}

// ─── Command: onboard ──────────────────────────────────────────────

/**
 * @brief Runs the first-run setup wizard.
 */
async function runOnboard(): Promise<void> {
  try {
    console.log("\n🌙 Welcome to Maia - First Run Setup\n");

    const homeDir = os.homedir();
    const maiaDir = path.join(homeDir, ".maia");
    const dataDir = path.join(maiaDir, "data");
    const workspaceDir = path.join(maiaDir, "workspace");
    const configPath = path.join(maiaDir, "maia.config.json");
    const envPath = path.join(maiaDir, ".env");

    const fs = createRealFileSystem();
    const crypto = createRealCryptoProvider();

    // Create directories
    console.log("Creating Maia directories...");
    await fs.mkdir(maiaDir);
    await fs.mkdir(dataDir);
    await fs.mkdir(workspaceDir);

    // Provider selection
    console.log("\nAvailable LLM providers:");
    console.log("  1. ollama    (local, free, requires Ollama running)");
    console.log("  2. groq      (cloud, free tier available)");
    console.log("  3. gemini    (cloud, free tier available)");
    console.log("  4. huggingface (cloud, free tier available)");
    console.log("  5. openrouter  (cloud, aggregator)");

    const providerChoice = await promptUser(
      "\nSelect primary provider (1-5) [1]: ",
    );
    const providers = [
      "ollama",
      "groq",
      "gemini",
      "huggingface",
      "openrouter",
    ] as const;
    const providerIndex = Math.max(
      0,
      Math.min(4, parseInt(providerChoice || "1", 10) - 1),
    );
    const primaryProvider = providers[providerIndex];

    const defaultModels: Record<typeof primaryProvider, string> = {
      ollama: "llama3.2",
      groq: "llama-3.3-70b-versatile",
      gemini: "gemini-3-flash-preview",
      huggingface: "HuggingFaceH4/zephyr-7b-beta",
      openrouter: "llama-3.3-70b-versatile",
    };
    const defaultModel = defaultModels[primaryProvider];

    // For cloud providers, get API key first so we can fetch available models
    let apiKeyForVault: string | undefined;
    if (primaryProvider !== "ollama") {
      const keyPrompt = await promptUser(
        `\nEnter your ${primaryProvider} API key (or leave blank to skip and use default model): `,
      );
      if (keyPrompt && keyPrompt.trim()) apiKeyForVault = keyPrompt.trim();
    }

    // Fetch available models (Ollama: always; cloud: only if we have a key)
    let models: ModelInfo[] = [];
    console.log("\nFetching available models...");
    if (primaryProvider === "ollama") {
      models = await fetchModelsForOnboarding(primaryProvider);
    } else if (apiKeyForVault) {
      models = await fetchModelsForOnboarding(primaryProvider, apiKeyForVault);
    }
    if (models.length > 0) {
      models = [...models].sort((a, b) => a.id.localeCompare(b.id, "en"));
      console.log(`Found ${models.length} model(s):`);
      models.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.name} (${m.id})`);
      });
    } else if (primaryProvider === "ollama") {
      console.log(
        "Could not reach Ollama (is it running?). You can enter a model name manually.",
      );
    } else if (
      (primaryProvider as "ollama" | "groq" | "gemini" | "huggingface" | "openrouter") !== "ollama" &&
      !apiKeyForVault
    ) {
      console.log(
        "Enter a model name below, or run onboard again and add your API key to list models.",
      );
    }

    let chosenModel: string;
    if (models.length > 0) {
      const modelInput = await promptUser(
        `\nEnter model number (1-${models.length}) or model name [${defaultModel}]: `,
      );
      const trimmed = modelInput?.trim() ?? "";
      const asNum = parseInt(trimmed, 10);
      if (trimmed === "") {
        chosenModel = defaultModel;
      } else if (
        Number.isFinite(asNum) &&
        asNum >= 1 &&
        asNum <= models.length
      ) {
        chosenModel = models[asNum - 1].id;
      } else {
        chosenModel = trimmed;
      }
    } else {
      const modelInput = await promptUser(
        `Enter model name [${defaultModel}]: `,
      );
      chosenModel = (modelInput && modelInput.trim()) || defaultModel;
    }

    // Gateway
    console.log("\n--- Gateway (for maia start / web UI) ---");
    const portStr = await promptUser("Gateway port [3000]: ");
    const gatewayPort = portStr ? parseInt(portStr, 10) : 3000;
    const port =
      Number.isFinite(gatewayPort) && gatewayPort > 0 ? gatewayPort : 3000;
    const host =
      (await promptUser("Gateway host (bind address) [0.0.0.0]: ")) ||
      "0.0.0.0";

    // Sandbox (file access restriction)
    console.log("\n--- Security sandbox ---");
    console.log(
      "The sandbox restricts file access to a single root directory.",
    );
    const sandboxChoice = await promptUser(
      "Enable sandbox? (recommended) [Y/n]: ",
    );
    const sandboxEnabled =
      sandboxChoice === "" || sandboxChoice.toLowerCase().startsWith("y");
    const defaultSandboxRoot = maiaDir;
    const sandboxRootInput = await promptUser(
      `Sandbox root directory [${defaultSandboxRoot}]: `,
    );
    const sandboxRoot = sandboxRootInput.trim() || defaultSandboxRoot;

    // --- Telegram (optional) ---
    let telegramEnabled = false;
    let telegramToken: string | undefined;
    let telegramUserChatId: string | undefined;
    let telegramWebhookSecret: string | undefined;

    const telegramChoice = await promptUser(
      "\nSet up Telegram for chat and notifications? (y/n) [n]: ",
    );
    if (
      telegramChoice.trim().toLowerCase() === "y" ||
      telegramChoice.trim().toLowerCase() === "yes"
    ) {
      console.log(
        "\nTelegram: Chat with @BotFather, run /newbot, then copy the bot token.",
      );
      const tokenInput = await promptUser(
        "Enter Telegram bot token (or leave blank to skip): ",
      );
      const token = tokenInput?.trim();
      if (token) {
        telegramEnabled = true;
        telegramToken = token;

        const maxUsernameAttempts = 3;
        let usernameAttempt = 0;
        let userTrimmed = "";

        do {
          const prompt =
            usernameAttempt === 0
              ? "Your Telegram (numeric id or @username; leave blank to add later in config): "
              : "Try again? Enter numeric id or @username, or leave blank to skip: ";
          const userInput = await promptUser(prompt);
          userTrimmed = userInput?.trim() ?? "";
          if (!userTrimmed) break;

          const numericOnly = /^\d+$/.test(userTrimmed);
          if (numericOnly) {
            telegramUserChatId = userTrimmed;
            break;
          }

          const username = userTrimmed.startsWith("@")
            ? userTrimmed
            : `@${userTrimmed}`;
          try {
            const getChatUrl = `https://api.telegram.org/bot${encodeURIComponent(token)}/getChat?chat_id=${encodeURIComponent(username)}`;
            const res = await fetch(getChatUrl);
            const data = (await res.json()) as {
              ok?: boolean;
              result?: { id?: number };
              description?: string;
            };
            if (data?.ok && typeof data.result?.id === "number") {
              telegramUserChatId = String(data.result.id);
              console.log(`Resolved ${username} to chat id ${telegramUserChatId}`);
              break;
            }
            const errMsg =
              typeof data?.description === "string"
                ? data.description
                : "Could not resolve username.";
            console.log("Telegram resolve failed: " + errMsg);
            usernameAttempt++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log("Network error resolving username: " + msg);
            usernameAttempt++;
          }
        } while (usernameAttempt < maxUsernameAttempts);

        if (userTrimmed && !telegramUserChatId) {
          console.log(
            "Add channels.telegram.userChatId in config later, or message your bot and use the chat id from getUpdates.",
          );
        }

        const secretInput = await promptUser(
          "Webhook secret for X-Telegram-Bot-Api-Secret-Token (or leave blank to add later): ",
        );
        const secret = secretInput?.trim();
        if (secret) telegramWebhookSecret = secret;
      }
    }

    // Build config
    const config: Record<string, unknown> = {
      identity: {
        name: "Maia",
        emoji: "🌙",
        personality: "helpful, security-conscious assistant",
      },
      workspace: { path: workspaceDir },
      provider: {
        primary: primaryProvider,
        model: chosenModel,
        ...(primaryProvider === "ollama"
          ? { ollama: { baseUrl: "http://localhost:11434" } }
          : {}),
        ...(primaryProvider !== "ollama"
          ? {
              [primaryProvider]: {
                credentialName: `${primaryProvider}-api-key`,
              },
            }
          : {}),
      },
      gateway: {
        port,
        host,
        auth: { token: "${MAIA_AUTH_TOKEN}" },
        cors: { origins: ["http://localhost:" + String(port)] },
      },
      channels: {
        cli: { enabled: true },
        webchat: { enabled: true },
        discord: { enabled: false },
        telegram: {
          enabled: telegramEnabled,
          credentialName: telegramEnabled ? "telegram-bot-token" : undefined,
          ...(telegramUserChatId && { userChatId: telegramUserChatId }),
          ...(telegramWebhookSecret && { webhookSecret: telegramWebhookSecret }),
        },
      },
      memory: { enabled: true },
      security: {
        sandbox: { enabled: sandboxEnabled, root: sandboxRoot },
      },
    };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log(`\nConfig written to: ${configPath}`);

    // Generate auth token and master key
    const authToken = Buffer.from(crypto.randomBytes(24)).toString("hex");
    const masterKey = Buffer.from(crypto.randomBytes(24)).toString("hex");

    const envContent = `# Maia Environment Variables (generated by maia onboard)
MAIA_AUTH_TOKEN=${authToken}
MAIA_MASTER_KEY=${masterKey}
MAIA_LOG_LEVEL=info
MAIA_CONFIG=${configPath}
`;
    await fs.writeFile(envPath, envContent);
    console.log(`Environment file written to: ${envPath}`);

    // Save API key and/or Telegram token to vault when collected during onboarding
    const needsVault =
      (primaryProvider !== "ollama" && apiKeyForVault) || telegramToken;
    if (needsVault) {
      const clock = createRealClock();
      process.env.MAIA_MASTER_KEY = masterKey;
      const salt = new TextEncoder().encode(`maia-salt-${workspaceDir}`);
      const derivedKey = await crypto.deriveKey(masterKey, salt);
      const auditLog = createAuditLog({
        fs,
        clock,
        logPath: path.join(dataDir, "audit.jsonl"),
      });
      const logger = createLogger({ level: "info", write: () => {} });
      const store = createCredentialStore({
        fs,
        crypto,
        auditLog,
        logger,
        vaultPath: path.join(dataDir, "credentials.enc"),
        masterKey: derivedKey,
      });
      if (primaryProvider !== "ollama" && apiKeyForVault) {
        await store.set(`${primaryProvider}-api-key`, apiKeyForVault);
        console.log(`API key stored securely in encrypted vault.`);
      }
      if (telegramToken) {
        await store.set("telegram-bot-token", telegramToken);
        console.log(`Telegram bot token stored securely in encrypted vault.`);
      }
    }

    // Create workspace template files
    console.log("\nInitializing workspace...");
    const templates: Record<string, string> = {
      "SOUL.md": "# Soul\n\nDefine your AI's core identity and values here.\n",
      "IDENTITY.md":
        "# Identity\n\nname: Maia\nemoji: 🌙\npersonality: helpful assistant\n",
      "USER.md": "# User\n\nYour preferences and context go here.\n",
    };
    for (const [name, content] of Object.entries(templates)) {
      await fs.writeFile(path.join(workspaceDir, name), content);
    }

    console.log("\n✅ Setup complete!");
    console.log("\nYour config and credentials are in " + maiaDir + ".");
    console.log(
      "Maia will load " +
        envPath +
        " automatically when you run maia chat or maia start.",
    );
    console.log("\nNext steps:");
    if (primaryProvider === "ollama") {
      console.log("  1. Make sure Ollama is running: ollama serve");
      console.log(`  2. Pull your model: ollama pull ${chosenModel}`);
    }
    console.log("  3. Start chatting: maia chat");
    console.log(
      "  4. Or start the server: maia start" +
        (port !== 3000 ? " (gateway will listen on port " + port + ")" : "") +
        "\n",
    );
  } catch (err) {
    console.error(
      "Onboarding failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

// ─── Command: credentials ──────────────────────────────────────────

/**
 * @brief Manages the encrypted credential vault.
 */
async function runCredentials(): Promise<void> {
  try {
    const subcommand = args[1] ?? "list";
    const env = createRealEnvProvider();
    const fs = createRealFileSystem();
    const crypto = createRealCryptoProvider();
    const clock = createRealClock();

    const maiaDir = expandHome("~/.maia");
    const dataDir = path.join(maiaDir, "data");
    const vaultPath = path.join(dataDir, "credentials.enc");
    const auditLogPath = path.join(dataDir, "audit.jsonl");

    const masterKeyPassphrase = env.get("MAIA_MASTER_KEY");
    if (!masterKeyPassphrase) {
      console.error("Error: MAIA_MASTER_KEY environment variable is not set.");
      console.error("Run 'maia onboard' first, or set it in your .env file.");
      process.exit(1);
    }

    const salt = new TextEncoder().encode(
      `maia-salt-${expandHome("~/.maia/workspace")}`,
    );
    const masterKey = await crypto.deriveKey(masterKeyPassphrase, salt);
    const logger = createLogger({ level: "warn", write: () => {} });
    const auditLog = createAuditLog({ fs, clock, logPath: auditLogPath });
    const store = createCredentialStore({
      fs,
      crypto,
      auditLog,
      logger,
      vaultPath,
      masterKey,
    });

    switch (subcommand) {
      case "add": {
        const name = args[2];
        if (!name) {
          console.error("Usage: maia credentials add <name>");
          process.exit(1);
        }
        const value = await promptUser(`Enter value for '${name}': `);
        if (!value) {
          console.error("No value provided.");
          process.exit(1);
        }
        await store.set(name, value);
        console.log(`Credential '${name}' stored securely.`);
        break;
      }
      case "list": {
        const creds = await store.list();
        if (creds.length === 0) {
          console.log("No credentials stored.");
        } else {
          console.log("\nStored credentials:");
          for (const cred of creds) {
            console.log(`  ${cred.name}  (added: ${cred.addedAt})`);
          }
          console.log();
        }
        break;
      }
      case "remove": {
        const name = args[2];
        if (!name) {
          console.error("Usage: maia credentials remove <name>");
          process.exit(1);
        }
        await store.remove(name);
        console.log(`Credential '${name}' removed.`);
        break;
      }
      default:
        console.error(`Unknown credentials subcommand: ${subcommand}`);
        console.error("Usage: maia credentials [add|list|remove]");
        process.exit(1);
    }
  } catch (err) {
    console.error(
      "Credential operation failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

// ─── Command: backup ───────────────────────────────────────────────

/**
 * @brief Creates an encrypted backup of the Maia data.
 */
async function runBackup(): Promise<void> {
  try {
    const outputPath =
      args[1] ?? expandHome(`~/.maia/backups/maia-backup-${Date.now()}.enc`);
    console.log("Creating encrypted backup...");

    const fs = createRealFileSystem();
    const crypto = createRealCryptoProvider();
    const env = createRealEnvProvider();

    const maiaDir = expandHome("~/.maia");
    const masterKeyPassphrase = env.get("MAIA_MASTER_KEY");
    if (!masterKeyPassphrase) {
      console.error("Error: MAIA_MASTER_KEY environment variable is not set.");
      console.error("Run 'maia onboard' first, or set it in your .env file.");
      process.exit(1);
    }
    const salt = new TextEncoder().encode(
      `maia-salt-${path.join(maiaDir, "workspace")}`,
    );
    const masterKey = await crypto.deriveKey(masterKeyPassphrase, salt);

    const logger = createLogger({
      level: "info",
      write: (line) => console.log(line),
    });

    // Ensure backup directory exists
    await fs.mkdir(path.dirname(outputPath));

    const exporter = createBackupExporter({
      fs,
      crypto,
      logger,
      workspacePath: path.join(maiaDir, "workspace"),
      dataPath: path.join(maiaDir, "data"),
      credentialsPath: path.join(maiaDir, "data", "credentials.enc"),
      masterKey,
    });

    await exporter.export(outputPath);
    console.log(`Backup saved to: ${outputPath}`);
  } catch (err) {
    console.error(
      "Backup failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

// ─── Command: restore ──────────────────────────────────────────────

/**
 * @brief Restores from an encrypted backup.
 */
async function runRestore(): Promise<void> {
  try {
    const inputPath = args[1];
    if (!inputPath) {
      console.error("Usage: maia restore <backup-path>");
      process.exit(1);
    }

    console.log(`Restoring from: ${inputPath}`);

    const fs = createRealFileSystem();
    const crypto = createRealCryptoProvider();
    const env = createRealEnvProvider();

    const maiaDir = expandHome("~/.maia");
    const masterKeyPassphrase = env.get("MAIA_MASTER_KEY");
    if (!masterKeyPassphrase) {
      console.error("Error: MAIA_MASTER_KEY environment variable is not set.");
      console.error("Run 'maia onboard' first, or set it in your .env file.");
      process.exit(1);
    }
    const salt = new TextEncoder().encode(
      `maia-salt-${path.join(maiaDir, "workspace")}`,
    );
    const masterKey = await crypto.deriveKey(masterKeyPassphrase, salt);

    const logger = createLogger({
      level: "info",
      write: (line) => console.log(line),
    });

    const restorer = createBackupRestorer({
      fs,
      crypto,
      logger,
      workspacePath: path.join(maiaDir, "workspace"),
      dataPath: path.join(maiaDir, "data"),
      credentialsPath: path.join(maiaDir, "data", "credentials.enc"),
      masterKey,
    });

    await restorer.restore(inputPath);
    console.log("Restore complete.");
  } catch (err) {
    console.error(
      "Restore failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

// ─── Command: schedule ─────────────────────────────────────────────

/**
 * @brief Manages scheduled tasks.
 */
async function runSchedule(): Promise<void> {
  let app;
  try {
    app = await createApp();
  } catch (err) {
    console.error(
      "Failed to start Maia:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  try {
    const subcommand = args[1] ?? "list";
    const ctx = app.getContext();

    const scheduler = createScheduler({
      fs: ctx.fs,
      clock: ctx.clock,
      schedulerPath: expandHome("~/.maia/data/scheduler.json"),
    });

    switch (subcommand) {
      case "list": {
        const tasks = await scheduler.list();
        if (tasks.length === 0) {
          console.log("No scheduled tasks.");
        } else {
          console.log("\nScheduled tasks:");
          for (const task of tasks) {
            console.log(
              `  [${task.id}] ${task.prompt} (${task.schedule}) - ${task.status}`,
            );
          }
          console.log();
        }
        break;
      }
      case "add": {
        const schedule = args[2];
        const prompt = args.slice(3).join(" ");
        if (!schedule || !prompt) {
          console.error("Usage: maia schedule add <schedule> <prompt>");
          console.error(
            'Example: maia schedule add "0 9 * * *" "Check the news"',
          );
          process.exit(1);
        }
        const task = await scheduler.add({
          schedule,
          prompt,
          channel: "cli",
        });
        console.log(`Task added: ${task.id}`);
        break;
      }
      case "remove": {
        const taskId = args[2];
        if (!taskId) {
          console.error("Usage: maia schedule remove <task-id>");
          process.exit(1);
        }
        await scheduler.remove(taskId);
        console.log(`Task removed: ${taskId}`);
        break;
      }
      default:
        console.error(`Unknown schedule subcommand: ${subcommand}`);
        process.exit(1);
    }

    await app.stop();
  } catch (err) {
    console.error(
      "Schedule operation failed:",
      err instanceof Error ? err.message : String(err),
    );
    await app.stop();
    process.exit(1);
  }
}

// ─── Command: watchdog ─────────────────────────────────────────────

/**
 * @brief Runs the watchdog daemon in standalone mode.
 */
async function runWatchdog(): Promise<void> {
  console.log("Starting Maia watchdog daemon...\n");

  let app;
  try {
    app = await createApp();
  } catch (err) {
    console.error(
      "Failed to start Maia:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
  const ctx = app.getContext();

  const threatDetector = createThreatDetector({
    clock: ctx.clock,
    windowDurationMs: ctx.config.watchdog.threatWindow.durationMs,
    bruteForceThreshold: ctx.config.watchdog.threatWindow.bruteForceThreshold,
    injectionThreshold: ctx.config.watchdog.threatWindow.injectionThreshold,
  });
  const alerter = createAlerter({
    channels: ctx.config.watchdog.alertChannels,
    logger: ctx.logger,
    shutdownCoordinator: ctx.shutdown,
    autoShutdown: ctx.config.watchdog.autoShutdown,
  });
  const emergencyShutdown = createEmergencyShutdown({
    shutdownCoordinator: ctx.shutdown,
    auditLog: ctx.auditLog,
    logger: ctx.logger,
  });
  const auditMonitor = createAuditMonitor({
    auditLog: ctx.auditLog,
    threatDetector,
    alerter,
    clock: ctx.clock,
    logger: ctx.logger,
    pollIntervalMs: ctx.config.watchdog.healthCheckIntervalMs,
  });

  const watchdog = createWatchdogDaemon({
    ctx,
    threatDetector,
    alerter,
    auditMonitor,
    emergencyShutdown,
    healthChecks: [],
    healthCheckIntervalMs: ctx.config.watchdog.healthCheckIntervalMs,
  });

  await watchdog.start();
  console.log("Watchdog is running. Press Ctrl+C to stop.\n");

  const handleShutdown = async () => {
    console.log("\nStopping watchdog...");
    await watchdog.stop();
    await app.stop();
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  await new Promise(() => {});
}

// ─── Command: doctor ───────────────────────────────────────────────

/**
 * @brief Runs a one-shot health check and prints results.
 */
async function runDoctor(): Promise<void> {
  console.log("\n🩺 Maia Health Check\n");

  const checks: Array<{
    name: string;
    status: "ok" | "warn" | "error";
    message: string;
  }> = [];

  // Check config file exists
  const configPath = expandHome(
    process.env.MAIA_CONFIG ?? "~/.maia/maia.config.json",
  );
  const fs = createRealFileSystem();

  const configExists = await fs.exists(configPath);
  checks.push({
    name: "Config file",
    status: configExists ? "ok" : "error",
    message: configExists ? configPath : `Not found: ${configPath}`,
  });

  // Check data directory
  const dataDir = expandHome("~/.maia/data");
  const dataExists = await fs.exists(dataDir);
  checks.push({
    name: "Data directory",
    status: dataExists ? "ok" : "warn",
    message: dataExists
      ? dataDir
      : `Not found: ${dataDir}. Run 'maia onboard' to set up.`,
  });

  // Check master key
  const env = createRealEnvProvider();
  const hasMasterKey = !!env.get("MAIA_MASTER_KEY");
  checks.push({
    name: "Master key",
    status: hasMasterKey ? "ok" : "error",
    message: hasMasterKey
      ? "Set in environment"
      : "MAIA_MASTER_KEY not set. Run 'maia onboard' or set in .env.",
  });

  // Check database
  const dbPath = path.join(dataDir, "maia.db");
  const dbExists = await fs.exists(dbPath);
  checks.push({
    name: "Database",
    status: dbExists ? "ok" : "warn",
    message: dbExists ? dbPath : "Not found. Will be created on first start.",
  });

  // Check workspace
  const workspaceDir = expandHome("~/.maia/workspace");
  const wsExists = await fs.exists(workspaceDir);
  checks.push({
    name: "Workspace",
    status: wsExists ? "ok" : "warn",
    message: wsExists
      ? workspaceDir
      : "Not found. Run 'maia onboard' to set up.",
  });

  // Try to boot the app if config exists
  if (configExists) {
    try {
      const app = await createApp();

      // Check provider health
      const providerRegistry = app.getProviderRegistry();
      try {
        const health = await providerRegistry.healthStatus();
        for (const [id, healthy] of health) {
          checks.push({
            name: `Provider: ${id}`,
            status: healthy ? "ok" : "warn",
            message: healthy ? "Healthy" : "Unreachable",
          });
        }
      } catch (err) {
        checks.push({
          name: "Provider health",
          status: "warn",
          message: `Could not check: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      await app.stop();
    } catch (err) {
      checks.push({
        name: "App boot",
        status: "error",
        message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Print results
  for (const check of checks) {
    const icon =
      check.status === "ok" ? "✅" : check.status === "warn" ? "⚠️ " : "❌";
    console.log(`  ${icon} ${check.name}: ${check.message}`);
  }

  const errors = checks.filter((c) => c.status === "error").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  console.log(
    `\n  ${checks.length} checks: ${checks.length - errors - warnings} passed, ${warnings} warnings, ${errors} errors\n`,
  );

  if (errors > 0) process.exit(1);
}

// ─── Main dispatcher ───────────────────────────────────────────────

/**
 * @brief Main CLI dispatcher.
 */
async function main(): Promise<void> {
  switch (command) {
    case "start":
      await runStart();
      break;

    case "chat":
      await runChat();
      break;

    case "onboard":
      await runOnboard();
      break;

    case "credentials":
      await runCredentials();
      break;

    case "backup":
      await runBackup();
      break;

    case "restore":
      await runRestore();
      break;

    case "schedule":
      await runSchedule();
      break;

    case "watchdog":
      await runWatchdog();
      break;

    case "doctor":
      await runDoctor();
      break;

    case "--version":
    case "-v":
      console.log("maia v0.1.0");
      break;

    case "--help":
    case "-h":
    case "help":
    default:
      printHelp();
      break;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
