/**
 * @fileoverview Core types for the Maia agentic system.
 * @module lib/types
 */

export interface HistoryEntry {
  id: string;
  role:
    | "user"
    | "agent"
    | "tool_call"
    | "tool_result"
    | "thinking"
    | "smart_context";
  content: string;
  /** Optional clarified command for this round (references and ambiguous terms only; meaning and structure preserved). */
  resolvedContent?: string;
  /** 1-based conversation round index (user message + following responses). */
  roundIndex?: number;
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
  /** Smart context runs per round (afterMessageIndex + run). Restored on refresh so all rounds show their phases. */
  smartContextRuns?: SmartContextRunEntry[];
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
export type ModelProviderId = "ollama" | "openrouter";

/**
 * One entry in models.json: provider, model name, and optional generation params.
 * Model id is derived as provider/name (e.g. ollama/llama3.2).
 */
export interface ModelsJsonEntry {
  provider: string;
  name: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  options?: Record<string, unknown>;
}

/**
 * Per-model generation parameters (temperature, sampling, etc.).
 * Keys in modelParams must be whitelisted model ids (e.g. ollama/qwen3.5-35b-a3b).
 * Used so models like Qwen3.5 can follow provider docs (e.g. Unsloth recommended settings).
 */
export interface ModelGenerationParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  /** Provider-specific options (e.g. Ollama num_ctx, enable_thinking). */
  options?: Record<string, unknown>;
}

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
  /** Base URL for MuninnDB (cognitive memory). When set, Maia uses Muninn for semantic memory. */
  muninnUrl: string;
  openRouterApiKey?: string;
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
  /** Auto-archive: files with updated_at older than this duration are excluded from knowledge_search unless include_archived is true. Value (positive integer). */
  archiveDurationValue: number;
  /** Auto-archive duration unit. */
  archiveDurationUnit:
    | "seconds"
    | "minutes"
    | "hours"
    | "days"
    | "months"
    | "years";
  /** Per-model generation params (keys must be whitelisted model ids). */
  modelParams: Record<string, ModelGenerationParams>;
}

export interface SettingsPublic {
  whitelistedModels: string[];
  heartbeatIntervalMinutes: number;
  ollamaBaseUrl: string;
  hasOllamaKey: boolean;
  /** MuninnDB REST base URL (e.g. http://localhost:8475). Empty = not configured. */
  muninnUrl: string;
  hasOpenRouterKey: boolean;
  hasBraveKey: boolean;
  hasBraveAnswersKey: boolean;
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
  /** @see Settings.archiveDurationValue */
  archiveDurationValue: number;
  /** @see Settings.archiveDurationUnit */
  archiveDurationUnit:
    | "seconds"
    | "minutes"
    | "hours"
    | "days"
    | "months"
    | "years";
  /** @see Settings.modelParams */
  modelParams: Record<string, ModelGenerationParams>;
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

/**
 * Pi-style agent loop events. Emitted by the agentic loop for persistence and SSE mapping.
 * @see docs/architecture/agent-system.md
 */
export type AgentLoopEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; loopIndex: number }
  | { type: "message_start" }
  | { type: "message_update"; delta: string }
  | {
      type: "message_end";
      content: string;
      toolCalls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
      }>;
    }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      content: string;
      toolArgs: Record<string, unknown>;
      /** When set, sent as SSE tool_result result (e.g. { error: string }); otherwise content is sent. */
      resultForSSE?: unknown;
    }
  | { type: "turn_end" }
  | { type: "agent_end"; finalContent?: string }
  | { type: "agent_error"; message: string };

/** Smart context pipeline phase for live progress in the chat UI. */
export type SmartContextPhase =
  | "clarified"
  | "queries"
  | "retrieval"
  | "filter"
  | "done";

/**
 * Preserved smart context run: phases seen this run plus final result detail.
 * Stored in UI state and not cleared when the agent responds; replaced only when a new run starts.
 */
export interface SmartContextRun {
  /** Phases completed or in progress, in order (queries → retrieval → filter → done). */
  phases: Array<{
    phase: SmartContextPhase;
    detail?: string;
    /** Actual step output for hover tooltip (e.g. query list, source IDs, summary snippet). */
    output?: string;
  }>;
  /** Set when phase "done" is received (e.g. "3 sources", "0 sources"). */
  doneDetail?: string;
  /** Full prompt sent to the agent (system + user + optional tool), shown in the done phase detail. */
  fullPrompt?: string;
}

/**
 * One smart context run plus the message index after which it is shown.
 * Stored per round so the full conversation (including all smart context) can be restored on refresh.
 */
export interface SmartContextRunEntry {
  afterMessageIndex: number;
  run: SmartContextRun;
}

// SSE event types
export type SSEEvent =
  | { type: "token"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: unknown }
  | {
      type: "smart_context_phase";
      phase: SmartContextPhase;
      detail?: string;
      /** Actual step output for hover tooltip. */
      output?: string;
      /** When phase is "done", the full prompt sent to the main LLM. */
      fullPrompt?: string;
    }
  | {
      type: "done";
      sessionId: string;
      compressed: HistoryEntry;
      original: HistoryEntry;
    }
  | { type: "error"; message: string };

export type SystemSSEEvent =
  | {
      event: "message";
      data: { sessionId: string; entry: HistoryEntry; participants: string[] };
    }
  | { event: "session_created"; data: { session: SessionMeta } }
  | {
      event: "session_updated";
      data: {
        sessionId: string;
        name: string;
        description: string;
        tags: string[];
      };
    }
  | {
      event: "agent_status";
      data: { agentId: string; status: "idle" | "running" | "paused" };
    }
  | { event: "heartbeat"; data: { timestamp: string } }
  | { event: "ping"; data: { timestamp: string } }
  | { event: "tasks_changed"; data: Record<string, never> }
  | {
      event: "queue_changed";
      data: {
        jobs: Array<{
          tool: string;
          args: Record<string, unknown>;
          caller?: string;
          priority: number;
        }>;
      };
    }
  | {
      event: "web_search_empty";
      data: { reason: "captcha" | "no_results_parsed"; query: string };
    }
  | {
      event: "cron_fired";
      data: { jobId: string; agentId: string; timestamp: string };
    }
  | {
      event: "question";
      data: {
        sessionId: string;
        requestId: string;
        questions: Array<{
          id: string;
          prompt: string;
          choices?: string[];
          allowOther: boolean;
        }>;
      };
    };
