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
      const body = JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
      });

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
        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            yield { content: "", done: true };
            break;
          }
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{
                delta?: { content?: string };
                finish_reason?: string;
              }>;
            };
            const content = parsed.choices?.[0]?.delta?.content ?? "";
            const done = parsed.choices?.[0]?.finish_reason != null;
            if (content || done) {
              yield { content, done };
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
