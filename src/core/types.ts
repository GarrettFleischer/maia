/**
 * @fileoverview Core dependency injection interfaces and shared types for the Maia system.
 * @module core/types
 *
 * @note Every module in Maia receives its dependencies through these interfaces
 * rather than importing singletons or accessing globals. This is the architectural
 * backbone that makes TDD possible.
 */

// ─── Filesystem Abstraction ───────────────────────────────────────

/**
 * @brief Filesystem abstraction for dependency injection.
 * @note No module should directly import Node/Bun `fs` -- use this interface instead.
 */
export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<FileStat>;
  checksum(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

/**
 * @brief File metadata returned by FileSystem.stat().
 */
export interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtime: Date;
}

// ─── Clock Abstraction ────────────────────────────────────────────

/**
 * @brief Clock abstraction for testable time operations.
 * @note Tests use fixedClock() to control time deterministically.
 */
export interface Clock {
  now(): Date;
  todayString(): string; // "YYYY-MM-DD"
  timestamp(): string; // ISO 8601
}

// ─── Environment Provider ─────────────────────────────────────────

/**
 * @brief Environment variable provider abstraction.
 */
export interface EnvProvider {
  get(key: string): string | undefined;
}

// ─── HTTP Client ──────────────────────────────────────────────────

/**
 * @brief HTTP client abstraction for dependency injection.
 * @note Providers inject this to make HTTP calls -- tests mock HTTP responses.
 */
export interface HttpClient {
  fetch(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

/**
 * @brief Options for an HTTP request.
 */
export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * @brief HTTP response structure.
 */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  ok: boolean;
}

// ─── Crypto Provider ──────────────────────────────────────────────

/**
 * @brief Cryptographic operations abstraction.
 */
export interface CryptoProvider {
  randomUUID(): string;
  randomBytes(size: number): Uint8Array;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  encrypt(data: string, key: Uint8Array): Promise<EncryptedPayload>;
  decrypt(payload: EncryptedPayload, key: Uint8Array): Promise<string>;
  deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array>;
  hash(data: string): string;
}

/**
 * @brief Encrypted data payload with IV and auth tag.
 */
export interface EncryptedPayload {
  iv: string; // base64
  data: string; // base64
  tag: string; // base64
}

// ─── Database Abstraction ─────────────────────────────────────────

/**
 * @brief Database abstraction for dependency injection.
 * @note Tests use inMemoryDatabase() for isolated testing.
 */
export interface Database {
  execute(sql: string, params?: unknown[]): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

// ─── Logger ───────────────────────────────────────────────────────

/**
 * @brief Log levels for the structured logger.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * @brief Structured logger interface.
 * @note Implementations must support sensitive data redaction.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ─── Event Bus ────────────────────────────────────────────────────

/**
 * @brief Event identifiers used by the lifecycle hook system.
 */
export type MaiaEvent =
  | "beforeAgentStart"
  | "afterAgentEnd"
  | "messageReceived"
  | "messageSent"
  | "memoryStored"
  | "memoryRecalled"
  | "providerSwitch"
  | "shutdownRequested"
  | "threatDetected"
  | "agentCreated"
  | "agentRemoved"
  | "agentScheduleTriggered"
  | "agentTaskCompleted"
  | "agentError"
  | "agentRequest"
  | "agentResponse";

/**
 * @brief Event handler function type.
 */
export type EventHandler = (data: Record<string, unknown>) => void | Promise<void>;

/**
 * @brief Event bus for the Observer pattern lifecycle hooks.
 */
export interface EventBus {
  on(event: MaiaEvent, handler: EventHandler): void;
  off(event: MaiaEvent, handler: EventHandler): void;
  emit(event: MaiaEvent, data: Record<string, unknown>): Promise<void>;
}

// ─── Credential Store ─────────────────────────────────────────────

/**
 * @brief Credential stored in the encrypted vault.
 */
export interface StoredCredential {
  value: string;
  addedAt: string; // ISO 8601
}

/**
 * @brief LLM-opaque credential store interface.
 * @note The LLM never sees credential values -- only names.
 */
export interface CredentialStore {
  get(name: string): Promise<StoredCredential>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<Array<{ name: string; addedAt: string }>>;
  has(name: string): Promise<boolean>;
}

// ─── Audit Log ────────────────────────────────────────────────────

/**
 * @brief Security audit event types.
 */
export type AuditEventType =
  | "AUTH_SUCCESS"
  | "AUTH_FAILURE"
  | "RATE_LIMIT"
  | "INJECTION_DETECTED"
  | "TOOL_CALL"
  | "MEMORY_WRITE"
  | "CREDENTIAL_ACCESS"
  | "CREDENTIAL_ADD"
  | "CREDENTIAL_REMOVE"
  | "SECRET_DETECTED"
  | "PRIVACY_MODE"
  | "SHUTDOWN"
  | "THREAT_DETECTED"
  | "HEALTH_CHECK"
  | "FILE_TAMPER"
  | "FILE_ACCESS_DENIED"
  | "CHECKIN_SECURITY_FLAG"
  | "INLINE_SECURITY_FLAG"
  | "AGENT_STOPPED_SECURITY"
  | "TOOL_EXECUTION";

/**
 * @brief Append-only security audit log interface.
 */
export interface AuditLog {
  log(event: AuditEventType, metadata: Record<string, unknown>): Promise<void>;
  read(options?: { since?: Date; type?: AuditEventType; limit?: number }): Promise<AuditEntry[]>;
}

/**
 * @brief Single entry in the audit log.
 */
export interface AuditEntry {
  timestamp: string;
  type: AuditEventType;
  metadata: Record<string, unknown>;
}

// ─── Shutdown Coordinator ─────────────────────────────────────────

/**
 * @brief Shutdown hook function type.
 */
export type ShutdownHook = (reason: string) => Promise<void>;

/**
 * @brief Coordinates graceful shutdown across all modules.
 */
export interface ShutdownCoordinator {
  register(name: string, hook: ShutdownHook, priority?: number): void;
  shutdown(reason: string): Promise<void>;
  isShuttingDown(): boolean;
}

// ─── MaiaContext (Aggregate DI Container) ─────────────────────────

/**
 * @brief Configuration for the Maia application (validated by Zod).
 */
export interface MaiaConfig {
  identity: {
    name: string;
    emoji: string;
    personality: string;
  };
  workspace: {
    path: string;
  };
  provider: {
    primary: string;
    model: string;
    fallback?: {
      provider: string;
      model: string;
    };
    healthCheck: {
      enabled: boolean;
      intervalMs: number;
      consecutiveFailures: number;
    };
    ollama?: { baseUrl: string };
    groq?: { credentialName: string };
    gemini?: { credentialName: string };
    huggingface?: { credentialName: string };
    openrouter?: { credentialName: string };
  };
  gateway: {
    port: number;
    host: string;
    auth: { token: string };
    cors: { origins: string[] };
  };
  channels: {
    cli: { enabled: boolean };
    webchat: { enabled: boolean };
    discord: { enabled: boolean; credentialName?: string };
    telegram: {
      enabled: boolean;
      credentialName?: string;
      userChatId?: string;
      webhookSecret?: string;
    };
  };
  memory: {
    enabled: boolean;
    embeddingProvider: string;
    embeddingModel: string;
    search: {
      hybrid: { enabled: boolean; vectorWeight: number; textWeight: number };
      defaultLimit: number;
    };
    autoCapture: boolean;
    autoRecall: boolean;
    consolidation: {
      schedule: string;
      onDemand: boolean;
      sizeThreshold: number;
    };
  };
  security: {
    rateLimiting: { maxRequests: number; windowMs: number };
    promptInjection: { detection: boolean; wrapping: boolean };
    ssrf: { blockPrivateIPs: boolean };
    encryption: { enabled: boolean; scope: string[] };
    secretScanner: { enabled: boolean; patterns: string[] };
    auditLog: { enabled: boolean };
    toolPermissions: Record<string, { allow?: string[]; deny?: string[] }>;
    sandbox: { enabled: boolean; root?: string };
  };
  scheduler: {
    enabled: boolean;
    checkIntervalMs: number;
    /** Interval for Maia's periodic brain run (ms). 0 = disabled. */
    maiaBrainIntervalMs: number;
  };
  watchdog: {
    enabled: boolean;
    healthCheckIntervalMs: number;
    threatWindow: {
      durationMs: number;
      bruteForceThreshold: number;
      injectionThreshold: number;
    };
    alertChannels: string[];
    autoShutdown: boolean;
  };
  session: {
    compaction: {
      thresholdPercent: number;
      preserveRecentMessages: number;
    };
  };
  backup: {
    includeAuditLog: boolean;
  };
  mcp?: {
    servers?: Array<{ name: string; command: string; args?: string[] }>;
  };
}

/**
 * @brief Aggregate dependency container created once at startup and threaded through all modules.
 * @note This is the root of the DI graph. Tests create this with createTestContext().
 */
export interface MaiaContext {
  readonly config: MaiaConfig;
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly env: EnvProvider;
  readonly http: HttpClient;
  readonly crypto: CryptoProvider;
  readonly db: Database;
  readonly logger: Logger;
  readonly events: EventBus;
  readonly credentials: CredentialStore;
  readonly auditLog: AuditLog;
  readonly shutdown: ShutdownCoordinator;
}

// ─── LLM Provider Types ──────────────────────────────────────────

/**
 * @brief Chat message in the LLM conversation.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

/**
 * @brief Options for a chat completion request.
 */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

/**
 * @brief A chunk of a streaming chat response.
 */
export interface ChatChunk {
  content: string;
  done: boolean;
  toolCalls?: ToolCall[];
}

/**
 * @brief Tool definition for function calling.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * @brief Tool call request from the LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * @brief Model information from a provider.
 */
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
}

/**
 * @brief LLM provider interface (Strategy pattern).
 */
export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ChatChunk>;
  embed?(texts: string[]): Promise<number[][]>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<boolean>;
  contextWindowSize(model: string): number;
}

// ─── Channel Types ────────────────────────────────────────────────

/**
 * @brief Inbound message from any channel.
 */
export interface InboundMessage {
  id: string;
  channelId: string;
  senderId: string;
  content: string;
  timestamp: string;
  isGroup: boolean;
  private?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * @brief Outbound message to a channel.
 */
export interface OutboundMessage {
  channelId: string;
  recipientId: string;
  content: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

/**
 * @brief Channel configuration.
 */
export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

/**
 * @brief Handler for inbound messages.
 */
export type InboundMessageHandler = (message: InboundMessage) => Promise<void>;

/**
 * @brief Channel adapter interface (Adapter pattern).
 */
export interface Channel {
  readonly id: string;
  readonly name: string;
  initialize(config: ChannelConfig): Promise<void>;
  shutdown(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: InboundMessageHandler): void;
}

/**
 * @brief Message formatter for channel-specific output.
 */
export interface MessageFormatter {
  format(content: string): string;
  splitIfNeeded(content: string, maxLength: number): string[];
}

// ─── Memory Types ─────────────────────────────────────────────────

/**
 * @brief Memory categories for database entries.
 */
export type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other";

/**
 * @brief A memory entry stored in the vector database (Tier 3).
 */
export interface MemoryEntry {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  embedding?: number[];
  sourceDate?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * @brief Search result from hybrid memory search.
 */
export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

/**
 * @brief Memory store interface (Repository pattern).
 */
export interface MemoryStore {
  store(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry>;
  search(query: string, options?: { category?: MemoryCategory; limit?: number }): Promise<MemorySearchResult[]>;
  get(id: string): Promise<MemoryEntry | null>;
  remove(id: string): Promise<void>;
  count(): Promise<number>;
}

// ─── Watchdog Types ───────────────────────────────────────────────

/**
 * @brief Alert severity levels for the watchdog.
 */
export type AlertLevel = "INFO" | "WARN" | "CRITICAL";

/**
 * @brief A watchdog alert.
 */
export interface WatchdogAlert {
  level: AlertLevel;
  pattern: string;
  message: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

// ─── Scheduled Task Types ─────────────────────────────────────────

/**
 * @brief Status of a scheduled task.
 */
export type TaskStatus = "pending" | "running" | "completed" | "failed";

/**
 * @brief A scheduled task or reminder.
 */
export interface ScheduledTask {
  id: string;
  schedule: string; // cron expression or ISO timestamp
  prompt: string;
  channel: string;
  status: TaskStatus;
  createdAt: string;
  lastRunAt?: string;
}

// ─── Knowledge Vault Types ────────────────────────────────────────

/**
 * @brief A note in the Obsidian knowledge vault.
 */
export interface KnowledgeNote {
  path: string; // relative path within knowledge/
  title: string;
  content: string;
  frontmatter: {
    tags: string[];
    created: string;
    updated: string;
    category?: string;
  };
  wikilinks: string[]; // extracted [[links]]
}
