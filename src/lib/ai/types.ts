export interface Message {
  role: "system" | "user" | "assistant" | "agent" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /** Optional return type descriptor for chaining (e.g. "string", "object", "TerminalResult", "SearchResult[]"). */
  returns?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  toolCalls: ToolCall[];
  stopped: boolean;
}

/** Optional parameters for AIProvider.complete (e.g. AbortSignal for cancellation). */
export interface CompleteOptions {
  signal?: AbortSignal;
  /** Called for each reasoning/thinking delta when the model streams thinking (e.g. Ollama message.thinking). */
  onThinkingToken?: (delta: string) => void;
}

export interface StreamChunk {
  type: "token" | "tool_call" | "done";
  content?: string;
  toolCall?: ToolCall;
}

/**
 * Unified stream event types (pi-ai style). All providers emit this shape.
 * @module lib/ai/types
 */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "thinking_delta"; delta: string }
  | { type: "usage"; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: "stop" };

/** Options for the unified stream API (e.g. AbortSignal). */
export interface StreamOptions {
  signal?: AbortSignal;
}

export interface AIProvider {
  /**
   * Stream completion events. Callers can consume with for await.
   * @returns AsyncIterable of StreamEvent (text_delta, tool_call, thinking_delta, usage, stop).
   */
  stream(
    messages: Message[],
    tools: ToolDefinition[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent>;

  complete(
    messages: Message[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    options?: CompleteOptions,
  ): Promise<AIResponse>;
}
