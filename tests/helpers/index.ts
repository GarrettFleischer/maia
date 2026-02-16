/**
 * @fileoverview Test helper factories for creating mock dependencies.
 * @module tests/helpers
 *
 * @note These helpers create fully-mocked MaiaContext instances and individual
 * dependency mocks for unit testing. Every module in Maia uses DI, so tests
 * inject these mocks instead of touching real filesystem, network, or database.
 */

import type {
  MaiaContext,
  MaiaConfig,
  FileSystem,
  FileStat,
  Clock,
  EnvProvider,
  HttpClient,
  HttpResponse,
  CryptoProvider,
  EncryptedPayload,
  Database,
  Logger,
  EventBus,
  MaiaEvent,
  EventHandler,
  CredentialStore,
  StoredCredential,
  AuditLog,
  AuditEntry,
  AuditEventType,
  ShutdownCoordinator,
  ShutdownHook,
} from "../../src/core/types.js";

// ─── LogCall capture type ─────────────────────────────────────────

/**
 * @brief Captured log call for assertions in tests.
 */
export interface LogCall {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

// ─── In-Memory FileSystem ─────────────────────────────────────────

/**
 * @brief Creates an in-memory filesystem with optional initial files.
 * @param files - Initial file contents keyed by path
 * @returns FileSystem implementation backed by a Map
 *
 * @example
 * const fs = inMemoryFileSystem({ "/config.json": '{ "port": 3000 }' });
 * const content = await fs.readFile("/config.json");
 */
export function inMemoryFileSystem(
  files?: Record<string, string>
): FileSystem & { files: Map<string, string> } {
  const store = new Map<string, string>(
    files ? Object.entries(files) : []
  );
  const dirs = new Set<string>();

  return {
    files: store,

    async readFile(path: string): Promise<string> {
      const content = store.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${path}`);
      }
      return content;
    },

    async writeFile(path: string, content: string): Promise<void> {
      store.set(path, content);
    },

    async appendFile(path: string, content: string): Promise<void> {
      const existing = store.get(path) ?? "";
      store.set(path, existing + content);
    },

    async exists(path: string): Promise<boolean> {
      return store.has(path) || dirs.has(path);
    },

    async readDir(path: string): Promise<string[]> {
      const prefix = path.endsWith("/") ? path : path + "/";
      const entries = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const firstSegment = rest.split("/")[0];
          entries.add(firstSegment);
        }
      }
      return [...entries];
    },

    async mkdir(path: string): Promise<void> {
      dirs.add(path);
    },

    async chmod(_path: string, _mode: number): Promise<void> {
      // No-op in memory
    },

    async stat(path: string): Promise<FileStat> {
      if (store.has(path)) {
        return {
          size: store.get(path)!.length,
          isFile: true,
          isDirectory: false,
          mtime: new Date(),
        };
      }
      if (dirs.has(path)) {
        return {
          size: 0,
          isFile: false,
          isDirectory: true,
          mtime: new Date(),
        };
      }
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    },

    async checksum(path: string): Promise<string> {
      const content = store.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file: ${path}`);
      }
      // Simple hash for testing
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash + char) | 0;
      }
      return hash.toString(16);
    },

    async remove(path: string): Promise<void> {
      store.delete(path);
      dirs.delete(path);
    },
  };
}

// ─── Fixed Clock ──────────────────────────────────────────────────

/**
 * @brief Creates a clock that always returns the given fixed time.
 * @param date - The fixed date to return (defaults to 2026-02-13T12:00:00Z)
 * @returns Clock implementation with fixed time
 *
 * @example
 * const clock = fixedClock(new Date("2026-02-13T12:00:00Z"));
 * clock.todayString(); // "2026-02-13"
 */
export function fixedClock(date?: Date): Clock {
  const d = date ?? new Date("2026-02-13T12:00:00.000Z");
  return {
    now: () => d,
    todayString: () => d.toISOString().slice(0, 10),
    timestamp: () => d.toISOString(),
  };
}

// ─── Static Env Provider ──────────────────────────────────────────

/**
 * @brief Creates an env provider with static values.
 * @param vars - Static environment variable map
 * @returns EnvProvider implementation
 */
export function staticEnv(vars?: Record<string, string>): EnvProvider {
  const map = new Map<string, string>(
    vars ? Object.entries(vars) : []
  );
  return {
    get: (key: string) => map.get(key),
  };
}

// ─── Mock HTTP Client ─────────────────────────────────────────────

/**
 * @brief Creates a mock HTTP client with canned responses.
 * @param responses - Map of URL patterns to responses
 * @returns HttpClient implementation that returns canned responses
 *
 * @example
 * const http = mockHttpClient(new Map([
 *   ["https://api.groq.com", { status: 200, headers: {}, body: '{}', ok: true }],
 * ]));
 */
export function mockHttpClient(
  responses?: Map<string, HttpResponse>
): HttpClient & { calls: Array<{ url: string; options?: unknown }> } {
  const callLog: Array<{ url: string; options?: unknown }> = [];
  const responseMap = responses ?? new Map<string, HttpResponse>();

  return {
    calls: callLog,
    async fetch(url: string, options?: unknown): Promise<HttpResponse> {
      callLog.push({ url, options });

      // Check for exact match first, then prefix match
      for (const [pattern, response] of responseMap) {
        if (url === pattern || url.startsWith(pattern)) {
          return response;
        }
      }

      return {
        status: 404,
        headers: {},
        body: "Not Found",
        ok: false,
      };
    },
  };
}

// ─── In-Memory Database ───────────────────────────────────────────

/**
 * @brief Creates an in-memory database for testing.
 * @returns Database implementation backed by arrays
 *
 * @note This is a simplified mock. For integration tests, use real SQLite.
 */
export function inMemoryDatabase(): Database & {
  executedSql: Array<{ sql: string; params?: unknown[] }>;
  tables: Map<string, unknown[]>;
} {
  const executedSql: Array<{ sql: string; params?: unknown[] }> = [];
  const tables = new Map<string, unknown[]>();

  return {
    executedSql,
    tables,

    async execute(sql: string, params?: unknown[]): Promise<void> {
      executedSql.push({ sql, params });
    },

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      executedSql.push({ sql, params });
      return [] as T[];
    },

    async close(): Promise<void> {
      // No-op
    },
  };
}

// ─── Mock Crypto Provider ─────────────────────────────────────────

/**
 * @brief Creates a deterministic crypto provider for testing.
 * @returns CryptoProvider with predictable outputs
 */
export function mockCryptoProvider(): CryptoProvider {
  let uuidCounter = 0;

  return {
    randomUUID: () => `test-uuid-${++uuidCounter}`,
    randomBytes: (size: number) => new Uint8Array(size).fill(0xaa),

    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
      if (a.length !== b.length) return false;
      let result = 0;
      for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
      }
      return result === 0;
    },

    async encrypt(data: string, _key: Uint8Array): Promise<EncryptedPayload> {
      // Simple reversible encoding for testing
      const encoded = Buffer.from(data).toString("base64");
      return {
        iv: "dGVzdC1pdg==", // "test-iv" in base64
        data: encoded,
        tag: "dGVzdC10YWc=", // "test-tag" in base64
      };
    },

    async decrypt(payload: EncryptedPayload, _key: Uint8Array): Promise<string> {
      return Buffer.from(payload.data, "base64").toString("utf-8");
    },

    async deriveKey(_passphrase: string, _salt: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(32).fill(0xbb);
    },

    hash: (data: string) => {
      let h = 0;
      for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
      }
      return h.toString(16);
    },
  };
}

// ─── Capturing Logger ─────────────────────────────────────────────

/**
 * @brief Creates a silent logger that captures all log calls for assertions.
 * @returns Logger with a `calls` array for inspection
 *
 * @example
 * const logger = capturingLogger();
 * myModule.doSomething(logger);
 * expect(logger.calls).toContainEqual({ level: "info", message: "Done" });
 */
export function capturingLogger(): Logger & { calls: LogCall[] } {
  const calls: LogCall[] = [];
  return {
    calls,
    debug: (message: string, meta?: Record<string, unknown>) =>
      calls.push({ level: "debug", message, meta }),
    info: (message: string, meta?: Record<string, unknown>) =>
      calls.push({ level: "info", message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      calls.push({ level: "warn", message, meta }),
    error: (message: string, meta?: Record<string, unknown>) =>
      calls.push({ level: "error", message, meta }),
  };
}

// ─── Mock Event Bus ───────────────────────────────────────────────

/**
 * @brief Creates an event bus that captures emitted events.
 * @returns EventBus with event tracking
 */
export function mockEventBus(): EventBus & {
  emittedEvents: Array<{ event: MaiaEvent; data: Record<string, unknown> }>;
} {
  const handlers = new Map<MaiaEvent, Set<EventHandler>>();
  const emittedEvents: Array<{ event: MaiaEvent; data: Record<string, unknown> }> = [];

  return {
    emittedEvents,

    on(event: MaiaEvent, handler: EventHandler): void {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
    },

    off(event: MaiaEvent, handler: EventHandler): void {
      handlers.get(event)?.delete(handler);
    },

    async emit(event: MaiaEvent, data: Record<string, unknown>): Promise<void> {
      emittedEvents.push({ event, data });
      const eventHandlers = handlers.get(event);
      if (eventHandlers) {
        for (const handler of eventHandlers) {
          await handler(data);
        }
      }
    },
  };
}

// ─── Mock Credential Store ────────────────────────────────────────

/**
 * @brief Creates an in-memory credential store.
 * @param initial - Initial credentials keyed by name
 * @returns CredentialStore implementation
 */
export function mockCredentialStore(
  initial?: Record<string, string>
): CredentialStore {
  const store = new Map<string, StoredCredential>();
  if (initial) {
    for (const [name, value] of Object.entries(initial)) {
      store.set(name, { value, addedAt: new Date().toISOString() });
    }
  }

  return {
    async get(name: string): Promise<StoredCredential> {
      const cred = store.get(name);
      if (!cred) throw new Error(`Credential not found: ${name}`);
      return cred;
    },
    async set(name: string, value: string): Promise<void> {
      store.set(name, { value, addedAt: new Date().toISOString() });
    },
    async remove(name: string): Promise<void> {
      store.delete(name);
    },
    async list(): Promise<Array<{ name: string; addedAt: string }>> {
      return [...store.entries()].map(([name, cred]) => ({
        name,
        addedAt: cred.addedAt,
      }));
    },
    async has(name: string): Promise<boolean> {
      return store.has(name);
    },
  };
}

// ─── Mock Audit Log ───────────────────────────────────────────────

/**
 * @brief Creates an in-memory audit log that captures all events.
 * @returns AuditLog with an entries array for inspection
 */
export function mockAuditLog(): AuditLog & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];

  return {
    entries,

    async log(event: AuditEventType, metadata: Record<string, unknown>): Promise<void> {
      entries.push({
        timestamp: new Date().toISOString(),
        type: event,
        metadata,
      });
    },

    async read(options?: {
      since?: Date;
      type?: AuditEventType;
      limit?: number;
    }): Promise<AuditEntry[]> {
      let result = [...entries];
      if (options?.since) {
        const since = options.since.toISOString();
        result = result.filter((e) => e.timestamp >= since);
      }
      if (options?.type) {
        result = result.filter((e) => e.type === options.type);
      }
      if (options?.limit) {
        result = result.slice(0, options.limit);
      }
      return result;
    },
  };
}

// ─── Mock Shutdown Coordinator ────────────────────────────────────

/**
 * @brief Creates a mock shutdown coordinator.
 * @returns ShutdownCoordinator that tracks registered hooks
 */
export function mockShutdownCoordinator(): ShutdownCoordinator & {
  hooks: Array<{ name: string; hook: ShutdownHook; priority: number }>;
  shutdownCalled: boolean;
  shutdownReason: string | null;
} {
  const hooks: Array<{ name: string; hook: ShutdownHook; priority: number }> = [];
  let shutdownCalled = false;
  let shutdownReason: string | null = null;

  return {
    hooks,
    get shutdownCalled() { return shutdownCalled; },
    get shutdownReason() { return shutdownReason; },

    register(name: string, hook: ShutdownHook, priority?: number): void {
      hooks.push({ name, hook, priority: priority ?? 0 });
    },

    async shutdown(reason: string): Promise<void> {
      shutdownCalled = true;
      shutdownReason = reason;
      const sorted = [...hooks].sort((a, b) => b.priority - a.priority);
      for (const { hook } of sorted) {
        await hook(reason);
      }
    },

    isShuttingDown(): boolean {
      return shutdownCalled;
    },
  };
}

// ─── Default Test Config ──────────────────────────────────────────

/**
 * @brief Creates a default MaiaConfig for testing.
 * @param overrides - Partial config to merge with defaults
 * @returns Complete MaiaConfig
 */
export function testConfig(overrides?: Partial<MaiaConfig>): MaiaConfig {
  const defaults: MaiaConfig = {
    identity: {
      name: "TestMaia",
      emoji: "🧪",
      personality: "test assistant",
    },
    workspace: {
      path: "/test/workspace",
    },
    provider: {
      primary: "ollama",
      model: "test-model",
      healthCheck: {
        enabled: false,
        intervalMs: 60000,
        consecutiveFailures: 3,
      },
      ollama: { baseUrl: "http://localhost:11434" },
    },
    gateway: {
      port: 3000,
      host: "0.0.0.0",
      auth: { token: "test-token-12345" },
      cors: { origins: ["http://localhost:3000"] },
    },
    channels: {
      cli: { enabled: true },
      webchat: { enabled: false },
      discord: { enabled: false },
      telegram: { enabled: false },
    },
    memory: {
      enabled: true,
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      search: {
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
        defaultLimit: 5,
      },
      autoCapture: true,
      autoRecall: true,
      consolidation: {
        schedule: "0 23 * * *",
        onDemand: true,
        sizeThreshold: 5000,
      },
    },
    security: {
      rateLimiting: { maxRequests: 60, windowMs: 60000 },
      promptInjection: { detection: true, wrapping: true },
      ssrf: { blockPrivateIPs: true },
      encryption: { enabled: false, scope: [] },
      secretScanner: { enabled: true, patterns: [] },
      auditLog: { enabled: true },
      sandbox: { enabled: true },
    },
    scheduler: {
      enabled: true,
      checkIntervalMs: 60000,
      maiaBrainIntervalMs: 0,
      maiaThinkingIntervalMs: 0,
    },
    watchdog: {
      enabled: true,
      healthCheckIntervalMs: 60000,
      threatWindow: {
        durationMs: 300000,
        bruteForceThreshold: 10,
        injectionThreshold: 5,
      },
      alertChannels: ["console"],
      autoShutdown: true,
    },
    session: {
      compaction: {
        thresholdPercent: 80,
        preserveRecentMessages: 10,
      },
    },
    backup: {
      includeAuditLog: false,
    },
  };

  return { ...defaults, ...overrides } as MaiaConfig;
}

// ─── createTestContext ────────────────────────────────────────────

/**
 * @brief Creates a fully-mocked MaiaContext for unit tests.
 * @param overrides - Partial context to override specific dependencies
 * @returns Complete MaiaContext with all mocked dependencies
 *
 * @example
 * const ctx = createTestContext({
 *   fs: inMemoryFileSystem({ "/config.json": "{}" }),
 *   clock: fixedClock(new Date("2026-01-01")),
 * });
 */
export function createTestContext(
  overrides?: Partial<MaiaContext>
): MaiaContext {
  return {
    config: overrides?.config ?? testConfig(),
    fs: overrides?.fs ?? inMemoryFileSystem(),
    clock: overrides?.clock ?? fixedClock(),
    env: overrides?.env ?? staticEnv(),
    http: overrides?.http ?? mockHttpClient(),
    crypto: overrides?.crypto ?? mockCryptoProvider(),
    db: overrides?.db ?? inMemoryDatabase(),
    logger: overrides?.logger ?? capturingLogger(),
    events: overrides?.events ?? mockEventBus(),
    credentials: overrides?.credentials ?? mockCredentialStore(),
    auditLog: overrides?.auditLog ?? mockAuditLog(),
    shutdown: overrides?.shutdown ?? mockShutdownCoordinator(),
  };
}
