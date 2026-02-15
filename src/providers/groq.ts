/**
 * @fileoverview Groq LLM provider adapter.
 * @module providers/groq
 *
 * @brief Implements LLMProvider for Groq API (OpenAI-compatible). Supports
 * chat streaming, model listing, and health checks. Requires API key from
 * CredentialStore.
 */

import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  CredentialStore,
  HttpClient,
  Logger,
  ModelInfo,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
import { ProviderError } from "../core/errors.js";

const BASE_URL = "https://api.groq.com/openai/v1";

/** @brief Dependencies for createGroqProvider */
export interface GroqProviderDeps {
  http: HttpClient;
  credentials: CredentialStore;
  logger: Logger;
  credentialName: string;
  model?: string;
}

const DEFAULT_MODEL = "llama-3.1-70b-versatile";

/**
 * @brief Maps ToolDefinition[] to OpenAI-compatible tools array.
 * @param tools - Maia tool definitions
 * @returns OpenAI API tools payload
 */
function toOpenAITools(tools: ToolDefinition[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  }));
}

/** @brief Accumulated tool call from streaming deltas (by index). */
interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * @brief Merges streaming tool_calls delta into accumulated map.
 */
function mergeToolCallsDelta(
  acc: Map<number, AccumulatedToolCall>,
  deltaToolCalls: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined
): void {
  if (!deltaToolCalls) return;
  for (const d of deltaToolCalls) {
    const idx = d.index ?? 0;
    let cur = acc.get(idx);
    if (!cur) {
      cur = { id: d.id ?? `call_${idx}`, name: "", arguments: "" };
      acc.set(idx, cur);
    }
    if (d.id) cur.id = d.id;
    if (d.function?.name) cur.name = d.function.name;
    if (d.function?.arguments != null) cur.arguments += d.function.arguments;
  }
}

/**
 * @brief Converts accumulated tool calls to ToolCall[] with parsed arguments.
 */
function accumulatedToToolCalls(acc: Map<number, AccumulatedToolCall>): ToolCall[] {
  const sorted = [...acc.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.map(([, v]) => {
    let args: Record<string, unknown> = {};
    try {
      if (v.arguments.trim()) args = JSON.parse(v.arguments) as Record<string, unknown>;
    } catch {
      // leave args empty on parse error
    }
    return { id: v.id, name: v.name, arguments: args };
  });
}

function getGroqContextSize(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes("mixtral")) return 32768;
  if (lower.includes("llama")) return 128000;
  return 8192;
}

/**
 * @brief Creates a Groq LLM provider.
 * @param deps - Dependencies: http, credentials, logger, credentialName, optional model
 * @returns LLMProvider implementation for Groq
 */
export function createGroqProvider(deps: GroqProviderDeps) {
  const { http, credentials, logger, credentialName, model = DEFAULT_MODEL } =
    deps;
  const id = "groq";
  const name = "Groq";

  return {
    get id() {
      return id;
    },
    get name() {
      return name;
    },

    async *chat(
      messages: ChatMessage[],
      options?: ChatOptions
    ): AsyncGenerator<ChatChunk> {
      const cred = await credentials.get(credentialName);
      const key = cred.value;

      const url = `${BASE_URL}/chat/completions`;
      const payload: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
      };
      if (options?.tools && options.tools.length > 0) {
        payload.tools = toOpenAITools(options.tools);
      }
      const body = JSON.stringify(payload);

      try {
        const res = await http.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body,
          signal: options?.signal,
        });

        if (!res.ok) {
          throw new Error(`Groq API error: ${res.status} ${res.body}`);
        }

        const lines = res.body.split("\n").filter((line) => line.startsWith("data: "));
        const toolCallsAcc = new Map<number, AccumulatedToolCall>();
        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            const toolCalls = accumulatedToToolCalls(toolCallsAcc);
            yield { content: "", done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
            break;
          }
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{
                delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
                finish_reason?: string;
              }>;
            };
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;
            const content = delta?.content ?? "";
            mergeToolCallsDelta(toolCallsAcc, delta?.tool_calls);
            if (content) {
              yield { content, done: false };
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Groq chat failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      const cred = await credentials.get(credentialName);
      const key = cred.value;

      try {
        const res = await http.fetch(`${BASE_URL}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
        });

        if (!res.ok) {
          throw new Error(`Groq list models error: ${res.status} ${res.body}`);
        }

        const data = JSON.parse(res.body) as {
          data?: Array<{ id: string; root?: string }>;
        };
        const models = data.data ?? [];

        return models.map((m) => ({
          id: m.id,
          name: m.id,
          contextWindow: getGroqContextSize(m.id),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Groq listModels failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async healthCheck(): Promise<boolean> {
      try {
        const cred = await credentials.get(credentialName);
        const key = cred.value;

        const res = await http.fetch(`${BASE_URL}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
        });
        return res.status === 200;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Groq health check failed", { error: msg });
        return false;
      }
    },

    contextWindowSize(modelId: string): number {
      return getGroqContextSize(modelId);
    },
  };
}
