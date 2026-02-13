/**
 * @fileoverview Hugging Face Inference API provider adapter.
 * @module providers/huggingface
 *
 * @brief Implements LLMProvider for Hugging Face inference API. Supports chat
 * completions, model listing, and health checks. Requires API token from
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

const BASE_URL = "https://api-inference.huggingface.co/models";

/** @brief Dependencies for createHuggingFaceProvider */
export interface HuggingFaceProviderDeps {
  http: HttpClient;
  credentials: CredentialStore;
  logger: Logger;
  credentialName: string;
  model?: string;
}

const DEFAULT_MODEL = "meta-llama/Llama-2-7b-chat-hf";

const HF_CONTEXT_SIZE = 4096;

/**
 * @brief Formats messages into a single prompt for HF text-generation models.
 * @param messages - Chat messages
 * @returns Formatted prompt string
 */
function formatPrompt(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const prefix = m.role === "user" ? "User: " : m.role === "assistant" ? "Assistant: " : "";
      return `${prefix}${m.content}`;
    })
    .join("\n\n");
}

/**
 * @brief Creates a Hugging Face LLM provider.
 * @param deps - Dependencies: http, credentials, logger, credentialName, optional model
 * @returns LLMProvider implementation for Hugging Face
 */
export function createHuggingFaceProvider(deps: HuggingFaceProviderDeps) {
  const { http, credentials, logger, credentialName, model = DEFAULT_MODEL } =
    deps;
  const id = "huggingface";
  const name = "Hugging Face";

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
      const token = cred.value;

      const prompt = formatPrompt(messages);
      const url = `${BASE_URL}/${model}`;
      const body = JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: options?.maxTokens ?? 512,
          temperature: options?.temperature,
          return_full_text: false,
        },
      });

      try {
        const res = await http.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body,
          signal: options?.signal,
        });

        if (!res.ok) {
          throw new Error(
            `Hugging Face API error: ${res.status} ${res.body}`
          );
        }

        const data = JSON.parse(res.body) as Array<{ generated_text?: string }>;
        const text = data?.[0]?.generated_text ?? "";
        yield { content: text, done: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Hugging Face chat failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      const cred = await credentials.get(credentialName);
      const token = cred.value;

      try {
        const res = await http.fetch(`${BASE_URL}/${model}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          throw new Error(
            `Hugging Face list models error: ${res.status} ${res.body}`
          );
        }

        return [
          {
            id: model,
            name: model,
            contextWindow: HF_CONTEXT_SIZE,
          },
        ];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Hugging Face listModels failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async healthCheck(): Promise<boolean> {
      try {
        const cred = await credentials.get(credentialName);
        const token = cred.value;

        const res = await http.fetch(`${BASE_URL}/${model}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        return res.status === 200;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Hugging Face health check failed", { error: msg });
        return false;
      }
    },

    contextWindowSize(_modelId: string): number {
      return HF_CONTEXT_SIZE;
    },
  };
}
