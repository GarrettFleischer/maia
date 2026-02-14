/**
 * @fileoverview Main entry point and CLI for the Maia AI assistant.
 * @module index
 *
 * @note This file handles CLI command parsing and bootstraps the application.
 * Available commands: start, chat, onboard, credentials, backup, restore,
 * schedule, watchdog, doctor.
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
import { startBunServer, registerApiRoutes } from "./gateway/bun-server.js";

// Channels
import { createCLIChannel } from "./channels/cli.js";
import { createMessageFormatter } from "./channels/formatter.js";

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
import { createAuditLog } from "./security/audit-log.js";
import { createCredentialStore } from "./security/credential-store.js";

import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

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

  const app = await createApp();
  const ctx = app.getContext();
  const runtime = app.getRuntime();

  // Set up CLI channel
  const formatter = createMessageFormatter("cli");
  const { rl, readLine } = createReadlineInterface();

  const cliChannel = createCLIChannel({
    logger: ctx.logger,
    crypto: ctx.crypto,
    formatter,
    readLine,
    writeLine: (line: string) => console.log(line),
  });

  // Wire channel to agent runtime
  cliChannel.onMessage(async (message) => {
    await runtime.handleMessage(message);
  });

  await cliChannel.initialize({ enabled: true });
  await (cliChannel as ReturnType<typeof createCLIChannel> & { injectInput: (input: string) => Promise<void> })
    .injectInput?.(""); // Check if injectInput exists

  console.log(`\n${ctx.config.identity.emoji} ${ctx.config.identity.name} is ready!`);
  console.log("Type your message, or /quit to exit, /private to toggle privacy mode.\n");

  // REPL loop
  while (true) {
    process.stdout.write("You: ");
    const input = await readLine();

    if (input === null || input === "/quit") {
      console.log("\nGoodbye!");
      break;
    }

    if (input.trim() === "") continue;

    if (input === "/private") {
      console.log("Privacy mode toggled. (Privacy features are active per session.)");
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

    // Send through the CLI channel
    const cliTyped = cliChannel as ReturnType<typeof createCLIChannel> & {
      injectInput: (input: string) => Promise<void>;
    };

    if (cliTyped.injectInput) {
      await cliTyped.injectInput(input);
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

  const app = await createApp();
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

  // Set up gateway
  const router = createRouter({ logger: ctx.logger });
  const authMiddleware = createAuthMiddleware(ctx);
  const rateLimitMiddleware = createRateLimitMiddleware(ctx);
  const corsMiddleware = createCorsMiddleware({
    allowedOrigins: ctx.config.gateway.cors.origins,
    logger: ctx.logger,
  });
  const errorHandler = createErrorHandler({ logger: ctx.logger });

  // Set up WebSocket handler
  const wsHandler = createWSHandler({
    logger: ctx.logger,
    events: ctx.events,
    onChatMessage: async (_connectionId, senderId, content) => {
      let reply = "";
      const message = {
        id: ctx.crypto.randomUUID(),
        channelId: "webchat",
        senderId,
        content,
        timestamp: ctx.clock.timestamp(),
        isGroup: false,
      };

      // Process through runtime
      await runtime.handleMessage(message);
      return reply || "I received your message.";
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

  // Register API routes
  registerApiRoutes(gateway, {
    startTime: Date.now(),
    onChat: async (message, senderId) => {
      let reply = "";
      const inbound = {
        id: ctx.crypto.randomUUID(),
        channelId: "api",
        senderId,
        content: message,
        timestamp: ctx.clock.timestamp(),
        isGroup: false,
      };
      await runtime.handleMessage(inbound);
      return reply || "Message processed.";
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

  // Start Bun HTTP server
  const bunServer = startBunServer({ config: ctx.config, gateway, logger: ctx.logger });

  // Register shutdown hook for the server
  ctx.shutdown.register("bun-server", async () => {
    bunServer.stop();
  }, 5);

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
    ctx.shutdown.register("watchdog", async () => {
      await watchdog.stop();
    }, 3);

    ctx.logger.info("Watchdog daemon started");
  }

  console.log(`\n${ctx.config.identity.emoji} ${ctx.config.identity.name} is running!`);
  console.log(`Gateway: ${bunServer.url}`);
  console.log(`WebSocket: ${bunServer.url.replace("http", "ws")}/ws`);
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

  const providerChoice = await promptUser("\nSelect primary provider (1-5) [1]: ");
  const providers = ["ollama", "groq", "gemini", "huggingface", "openrouter"] as const;
  const providerIndex = Math.max(0, Math.min(4, parseInt(providerChoice || "1", 10) - 1));
  const primaryProvider = providers[providerIndex];

  const model = await promptUser(`Enter model name [${primaryProvider === "ollama" ? "llama3.2" : "default"}]: `);

  // Build config
  const config: Record<string, unknown> = {
    identity: { name: "Maia", emoji: "🌙", personality: "helpful, security-conscious assistant" },
    workspace: { path: workspaceDir },
    provider: {
      primary: primaryProvider,
      model: model || (primaryProvider === "ollama" ? "llama3.2" : "llama-3.3-70b-versatile"),
      ...(primaryProvider === "ollama" ? { ollama: { baseUrl: "http://localhost:11434" } } : {}),
      ...(primaryProvider !== "ollama" ? { [primaryProvider]: { credentialName: `${primaryProvider}-api-key` } } : {}),
    },
    gateway: {
      port: 3000,
      auth: { token: "${MAIA_AUTH_TOKEN}" },
    },
    channels: {
      cli: { enabled: true },
      webchat: { enabled: true },
      discord: { enabled: false },
      telegram: { enabled: false },
    },
    memory: { enabled: true },
    security: {
      sandbox: { enabled: true, root: maiaDir },
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

  // If provider needs an API key, prompt for it
  if (primaryProvider !== "ollama") {
    const apiKey = await promptUser(`\nEnter your ${primaryProvider} API key: `);
    if (apiKey) {
      // We need to boot a minimal credential store to save the key
      const clock = createRealClock();
      process.env.MAIA_MASTER_KEY = masterKey;
      const salt = new TextEncoder().encode(`maia-salt-${workspaceDir}`);
      const derivedKey = await crypto.deriveKey(masterKey, salt);
      const auditLog = createAuditLog({
        fs,
        clock,
        logPath: path.join(dataDir, "audit.jsonl"),
      });
      const { createLogger } = await import("./core/logger.js");
      const logger = createLogger({ level: "info", write: () => {} });
      const store = createCredentialStore({
        fs,
        crypto,
        auditLog,
        logger,
        vaultPath: path.join(dataDir, "credentials.enc"),
        masterKey: derivedKey,
      });
      await store.set(`${primaryProvider}-api-key`, apiKey);
      console.log(`API key stored securely in encrypted vault.`);
    }
  }

  // Create workspace template files
  console.log("\nInitializing workspace...");
  const templates: Record<string, string> = {
    "SOUL.md": "# Soul\n\nDefine your AI's core identity and values here.\n",
    "IDENTITY.md": "# Identity\n\nname: Maia\nemoji: 🌙\npersonality: helpful assistant\n",
    "USER.md": "# User\n\nYour preferences and context go here.\n",
  };
  for (const [name, content] of Object.entries(templates)) {
    await fs.writeFile(path.join(workspaceDir, name), content);
  }

  console.log("\n✅ Setup complete!");
  console.log("\nNext steps:");
  if (primaryProvider === "ollama") {
    console.log("  1. Make sure Ollama is running: ollama serve");
    console.log(`  2. Pull your model: ollama pull ${model || "llama3.2"}`);
  }
  console.log("  3. Start chatting: bun run src/index.ts chat");
  console.log("  4. Or start the server: bun run src/index.ts start\n");
}

// ─── Command: credentials ──────────────────────────────────────────

/**
 * @brief Manages the encrypted credential vault.
 */
async function runCredentials(): Promise<void> {
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

  const salt = new TextEncoder().encode(`maia-salt-${expandHome("~/.maia/workspace")}`);
  const masterKey = await crypto.deriveKey(masterKeyPassphrase, salt);
  const { createLogger } = await import("./core/logger.js");
  const logger = createLogger({ level: "warn", write: () => {} });
  const auditLog = createAuditLog({ fs, clock, logPath: auditLogPath });
  const store = createCredentialStore({ fs, crypto, auditLog, logger, vaultPath, masterKey });

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
}

// ─── Command: backup ───────────────────────────────────────────────

/**
 * @brief Creates an encrypted backup of the Maia data.
 */
async function runBackup(): Promise<void> {
  const outputPath = args[1] ?? expandHome(`~/.maia/backups/maia-backup-${Date.now()}.enc`);
  console.log("Creating encrypted backup...");

  const fs = createRealFileSystem();
  const crypto = createRealCryptoProvider();
  const env = createRealEnvProvider();

  const maiaDir = expandHome("~/.maia");
  const masterKeyPassphrase = env.get("MAIA_MASTER_KEY") ?? "maia-default-key";
  const salt = new TextEncoder().encode(`maia-salt-${path.join(maiaDir, "workspace")}`);
  const masterKey = await crypto.deriveKey(masterKeyPassphrase, salt);

  const { createLogger } = await import("./core/logger.js");
  const logger = createLogger({ level: "info", write: (line) => console.log(line) });

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
}

// ─── Command: restore ──────────────────────────────────────────────

/**
 * @brief Restores from an encrypted backup.
 */
async function runRestore(): Promise<void> {
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
  const masterKeyPassphrase = env.get("MAIA_MASTER_KEY") ?? "maia-default-key";
  const salt = new TextEncoder().encode(`maia-salt-${path.join(maiaDir, "workspace")}`);
  const masterKey = await crypto.deriveKey(masterKeyPassphrase, salt);

  const { createLogger } = await import("./core/logger.js");
  const logger = createLogger({ level: "info", write: (line) => console.log(line) });

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
}

// ─── Command: schedule ─────────────────────────────────────────────

/**
 * @brief Manages scheduled tasks.
 */
async function runSchedule(): Promise<void> {
  const subcommand = args[1] ?? "list";
  const app = await createApp();
  const ctx = app.getContext();

  const { createScheduler } = await import("./agent/scheduler.js");
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
          console.log(`  [${task.id}] ${task.prompt} (${task.schedule}) - ${task.status}`);
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
        console.error('Example: maia schedule add "0 9 * * *" "Check the news"');
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
}

// ─── Command: watchdog ─────────────────────────────────────────────

/**
 * @brief Runs the watchdog daemon in standalone mode.
 */
async function runWatchdog(): Promise<void> {
  console.log("Starting Maia watchdog daemon...\n");

  const app = await createApp();
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

  const checks: Array<{ name: string; status: "ok" | "warn" | "error"; message: string }> = [];

  // Check config file exists
  const configPath = expandHome(process.env.MAIA_CONFIG ?? "~/.maia/maia.config.json");
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
    message: dataExists ? dataDir : `Not found: ${dataDir}. Run 'maia onboard' to set up.`,
  });

  // Check master key
  const env = createRealEnvProvider();
  const hasMasterKey = !!env.get("MAIA_MASTER_KEY");
  checks.push({
    name: "Master key",
    status: hasMasterKey ? "ok" : "warn",
    message: hasMasterKey ? "Set in environment" : "MAIA_MASTER_KEY not set. Using default.",
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
    message: wsExists ? workspaceDir : "Not found. Run 'maia onboard' to set up.",
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
    const icon = check.status === "ok" ? "✅" : check.status === "warn" ? "⚠️ " : "❌";
    console.log(`  ${icon} ${check.name}: ${check.message}`);
  }

  const errors = checks.filter((c) => c.status === "error").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  console.log(`\n  ${checks.length} checks: ${checks.length - errors - warnings} passed, ${warnings} warnings, ${errors} errors\n`);

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
