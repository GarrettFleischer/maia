/**
 * @fileoverview LLM request/response monitoring proxy for sub-agents.
 * @module agents/monitor
 *
 * @brief Wraps an LLMProvider and intercepts every chat call to log requests
 * and responses. Emits events that Maia can subscribe to for oversight.
 * Token usage and tool call patterns are tracked per agent.
 */

import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  EventBus,
  LLMProvider,
  Logger,
  ModelInfo,
} from "../core/types.js";

/**
 * @brief Monitoring callback signatures.
 */
export interface MonitorCallbacks {
  /** Called before an LLM request is sent */
  onRequest?: (params: {
    agentId: string;
    messages: ChatMessage[];
    options?: ChatOptions;
  }) => void;
  /** Called after a complete LLM response is collected */
  onResponse?: (params: {
    agentId: string;
    content: string;
    toolCalls: number;
    durationMs: number;
  }) => void;
}

/**
 * @brief Dependencies for createMonitoredProvider.
 */
export interface MonitoredProviderDeps {
  /** The underlying provider to wrap */
  provider: LLMProvider;
  /** Agent ID for attribution */
  agentId: string;
  logger: Logger;
  events: EventBus;
  callbacks?: MonitorCallbacks;
}

/**
 * @brief Creates a monitored LLM provider that wraps another provider.
 * @param deps - Dependencies: provider, agentId, logger, events, callbacks
 * @returns LLMProvider proxy that logs all requests and responses
 *
 * @example
 * const monitored = createMonitoredProvider({
 *   provider: geminiProvider,
 *   agentId: "research-bot",
 *   logger, events,
 * });
 * // Use monitored just like a regular LLMProvider
 * const stream = monitored.chat(messages, options);
 */
export function createMonitoredProvider(deps: MonitoredProviderDeps): LLMProvider {
  const { provider, agentId, logger, events, callbacks } = deps;

  return {
    get id() { return provider.id; },
    get name() { return `monitored:${agentId}:${provider.name}`; },

    async *chat(
      messages: ChatMessage[],
      options?: ChatOptions
    ): AsyncGenerator<ChatChunk> {
      const startTime = Date.now();

      // Log request
      const promptSummary = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content.slice(0, 100))
        .join(" | ");

      logger.debug("Agent LLM request", {
        agentId,
        provider: provider.id,
        messageCount: messages.length,
        promptSummary,
        hasTools: !!(options?.tools && options.tools.length > 0),
      });

      callbacks?.onRequest?.({ agentId, messages, options });

      // Intercept stream, collecting full response
      let fullContent = "";
      let toolCallCount = 0;

      const stream = provider.chat(messages, options);
      for await (const chunk of stream) {
        fullContent += chunk.content;
        if (chunk.toolCalls) {
          toolCallCount += chunk.toolCalls.length;
        }
        yield chunk;
      }

      const durationMs = Date.now() - startTime;

      // Log response
      logger.debug("Agent LLM response", {
        agentId,
        provider: provider.id,
        responseLength: fullContent.length,
        toolCalls: toolCallCount,
        durationMs,
      });

      callbacks?.onResponse?.({
        agentId,
        content: fullContent,
        toolCalls: toolCallCount,
        durationMs,
      });

      // Emit events for Maia to subscribe to
      await events.emit("agentResponse" as Parameters<typeof events.emit>[0], {
        agentId,
        provider: provider.id,
        responseLength: fullContent.length,
        toolCalls: toolCallCount,
        durationMs,
      });
    },

    embed: provider.embed
      ? async (texts: string[]) => provider.embed!(texts)
      : undefined,

    async listModels(): Promise<ModelInfo[]> {
      return provider.listModels();
    },

    async healthCheck(): Promise<boolean> {
      return provider.healthCheck();
    },

    contextWindowSize(model: string): number {
      return provider.contextWindowSize(model);
    },
  };
}
