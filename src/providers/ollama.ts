/**
 * @fileoverview Ollama LLM provider adapter.
 * @module providers/ollama
 *
 * @brief Implements LLMProvider for local Ollama API. Supports chat streaming,
 * embeddings, model listing, and health checks. No credentials required.
 */

import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  HttpClient,
  Logger,
  ModelInfo,
} from "../core/types.js";
import { ProviderError } from "../core/errors.js";

/** @brief Dependencies for createOllamaProvider */
export interface OllamaProviderDeps {
  http: HttpClient;
  logger: Logger;
  baseUrl: string;
  model?: string;
}

const DEFAULT_MODEL = "llama3.2";
const DEFAULT_CONTEXT = 4096;
const LLAMA_31_CONTEXT = 8192;

/**
 * @brief Creates an Ollama LLM provider.
 * @param deps - Dependencies: http, logger, baseUrl, optional model
 * @returns LLMProvider implementation for Ollama
 */
function getOllamaContextSize(modelId: string): number {
  return modelId.toLowerCase().includes("llama3.1")
    ? LLAMA_31_CONTEXT
    : DEFAULT_CONTEXT;
}

export function createOllamaProvider(deps: OllamaProviderDeps) {
  const { http, logger, baseUrl, model = DEFAULT_MODEL } = deps;
  const id = "ollama";
  const name = "Ollama";

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
      const url = `${baseUrl.replace(/\/$/, "")}/api/chat`;
      const body = JSON.stringify({
        model,
        messages,
        stream: true,
        options: {
          temperature: options?.temperature,
          num_predict: options?.maxTokens,
        },
      });

      try {
        const res = await http.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: options?.signal,
        });

        if (!res.ok) {
          throw new Error(`Ollama API error: ${res.status} ${res.body}`);
        }

        const lines = res.body.split("\n").filter((line) => line.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };
            const content = parsed.message?.content ?? "";
            const done = parsed.done ?? false;
            yield { content, done };
          } catch {
            // Skip malformed NDJSON lines
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Ollama chat failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async embed(texts: string[]): Promise<number[][]> {
      const url = `${baseUrl.replace(/\/$/, "")}/api/embed`;
      const body = JSON.stringify({ model, input: texts });

      try {
        const res = await http.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        if (!res.ok) {
          throw new Error(`Ollama embed error: ${res.status} ${res.body}`);
        }

        const data = JSON.parse(res.body) as { embeddings?: number[][] };
        return data.embeddings ?? [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Ollama embed failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;

      try {
        const res = await http.fetch(url, { method: "GET" });

        if (!res.ok) {
          throw new Error(`Ollama list models error: ${res.status} ${res.body}`);
        }

        const data = JSON.parse(res.body) as {
          models?: Array<{ name: string; details?: { parameter_size?: string } }>;
        };
        const models = data.models ?? [];

        return models.map((m) => ({
          id: m.name,
          name: m.name,
          contextWindow: getOllamaContextSize(m.name),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Ollama listModels failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async healthCheck(): Promise<boolean> {
      try {
        const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
        const res = await http.fetch(url, { method: "GET" });
        return res.status === 200;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Ollama health check failed", { error: msg });
        return false;
      }
    },

    contextWindowSize(modelId: string): number {
      return getOllamaContextSize(modelId);
    },
  };
}
