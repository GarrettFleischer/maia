/**
 * @fileoverview Core types for the Maia agentic system.
 * @module lib/types
 */

export interface HistoryEntry {
  id: string;
  role: "user" | "agent" | "tool_call" | "tool_result";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  timestamp: string;
}

export interface Session {
  id: string;
  name: string;
  description: string;
  participants: string[];
  tags: string[];
  type: "user" | "agents";
  original: HistoryEntry[];
  compressed: HistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionMeta {
  id: string;
  name: string;
  description: string;
  participants: string[];
  tags: string[];
  type: "user" | "agents";
  createdAt: string;
  updatedAt: string;
}

/** Reasoning effort applied when using this agent's model (Ollama think / OpenRouter reasoning.effort). */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

/** Provider identifier for AI models used in Maia. */
export type ModelProviderId = "ollama" | "openrouter" | "vllm" | "docker";

/** Capabilities for a single model (used by /api/model-capabilities and settings UI). */
export interface ModelCapabilities {
  /** Provider inferred from the model id prefix (e.g. ollama/, openrouter/). */
  provider: ModelProviderId;
  /**
   * Whether the model supports structured reasoning / "thinking" parameters.
   * When false, reasoning effort dropdowns should be disabled and providers
   * should avoid sending think/reasoning parameters.
   */
  supportsReasoning: boolean;
}

export interface AgentDefinition {
  id: string;
  name: string;
  model: string;
  /** Reasoning effort for this agent; applied via the correct API for the model's provider. */
  reasoningEffort: ReasoningEffort;
  status: "active" | "paused" | "deleted";
  systemPromptExtra?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWithIdentity extends AgentDefinition {
  soul: string;
  memory: string;
  user: string;
  /** Content of AGENTS.md from the agent's directory (data/agents/<id>/AGENTS.md). */
  agentsMd: string;
}

export interface AgentCreateConfig {
  name: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  soul?: string;
  memory?: string;
  user?: string;
  systemPromptExtra?: string;
}

export interface CronJob {
  id: string;
  expression: string;
  taskDescription: string;
  agentId: string;
  isBuiltIn: boolean;
  createdAt: string;
  /** Tool to call when the job fires. */
  toolName: string;
  /** Arguments for the tool (JSON object). */
  toolArgs: Record<string, unknown>;
  /** Human-readable schedule (e.g. "Every 30 minutes"). Set by API when listing jobs. */
  scheduleDescription?: string;
  /** Next run time in ISO format. Set by API when listing jobs. */
  nextRunAt?: string;
}

export interface TaskNote {
  agentId: string;
  content: string;
  timestamp: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done";
  createdBy: string;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  notes: TaskNote[];
}

export interface SecurityEvent {
  id: string;
  agentId: string;
  sessionId: string;
  eventType: string;
  detail: string;
  occurredAt: string;
}

export interface Settings {
  whitelistedModels: string[];
  heartbeatIntervalMinutes: number;
  ollamaBaseUrl: string;
  /** Optional API key for Ollama Cloud (Bearer token). When set, sent as Authorization header. */
  ollamaApiKey?: string;
  openRouterApiKey?: string;
  /** vLLM server base URL (e.g. http://localhost:8000/v1). */
  vllmBaseUrl: string;
  /** Docker-hosted OpenAI-compatible API base URL (e.g. http://localhost:8000/v1). */
  dockerBaseUrl: string;
  /** Embedding model for knowledge base and history semantic search (e.g. nomic-embed-text). */
  embeddingModel: string;
  /** Max characters to send to the embedding model per chunk (avoids context-length 400). Default 4000. */
  embedMaxContentLength: number;
  /**
   * Model used to extract JSON search-query arrays from user messages (first step of smart context).
   * When empty, smart context is disabled and only recent thread turns are used.
   */
  contextQueryModel: string;
  /**
   * Model used for relevance filtering and verbatim quote extraction from retrieved sources.
   * Filters which retrieved sources are relevant, then extracts focused quotes per source (with cleanup).
   * When empty, falls back to contextQueryModel; if both are empty smart context is disabled.
   */
  contextSummaryModel: string;
  /**
   * Number of most recent user rounds to include verbatim in context.
   * A round is one user message plus all assistant/tool entries until the next user message.
   * Default 3, min 1.
   */
  contextRecentTurns: number;
  /** Reasoning effort for smart context (query, relevance filter, and quote extraction models). Same API as per-agent effort. */
  contextReasoningEffort: ReasoningEffort;
}

export interface SettingsPublic {
  whitelistedModels: string[];
  heartbeatIntervalMinutes: number;
  ollamaBaseUrl: string;
  hasOllamaKey: boolean;
  hasOpenRouterKey: boolean;
  hasBraveKey: boolean;
  hasBraveAnswersKey: boolean;
  vllmBaseUrl: string;
  dockerBaseUrl: string;
  embeddingModel: string;
  embedMaxContentLength: number;
  /** @see Settings.contextQueryModel */
  contextQueryModel: string;
  /** @see Settings.contextSummaryModel */
  contextSummaryModel: string;
  /**
   * Number of most recent user rounds to include verbatim in context.
   * A round is one user message plus all assistant/tool entries until the next user message.
   * @see Settings.contextRecentTurns
   */
  contextRecentTurns: number;
  /** @see Settings.contextReasoningEffort */
  contextReasoningEffort: ReasoningEffort;
}

export interface EncryptedValue {
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  fetchedAt: string;
  injectionWarning?: string;
}

/** Result of fetch_web_page: URL, title, main text content, and optional injection warning. */
export interface WebPageContent {
  url: string;
  title: string;
  content: string;
  fetchedAt: string;
  injectionWarning?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// SSE event types
export type SSEEvent =
  | { type: "token"; content: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "done"; sessionId: string; compressed: HistoryEntry; original: HistoryEntry }
  | { type: "error"; message: string };

export type SystemSSEEvent =
  | { event: "message"; data: { sessionId: string; entry: HistoryEntry; participants: string[] } }
  | { event: "session_created"; data: { session: SessionMeta } }
  | { event: "session_updated"; data: { sessionId: string; name: string; description: string; tags: string[] } }
  | { event: "agent_status"; data: { agentId: string; status: "idle" | "running" | "paused" } }
  | { event: "heartbeat"; data: { timestamp: string } }
  | { event: "ping"; data: { timestamp: string } }
  | { event: "tasks_changed"; data: Record<string, never> }
  | { event: "web_search_empty"; data: { reason: "captcha" | "no_results_parsed"; query: string } }
  | { event: "cron_fired"; data: { jobId: string; agentId: string; timestamp: string } };
