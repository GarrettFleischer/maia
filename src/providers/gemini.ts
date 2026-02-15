/**
 * @fileoverview Google Gemini LLM provider adapter.
 * @module providers/gemini
 *
 * @brief Implements LLMProvider for Google Gemini API. Supports chat
 * completions, model listing, and health checks. Requires API key from
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
  ToolDefinition,
  ToolCall,
} from "../core/types.js";
import { ProviderError } from "../core/errors.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** @brief Dependencies for createGeminiProvider */
export interface GeminiProviderDeps {
  http: HttpClient;
  credentials: CredentialStore;
  logger: Logger;
  credentialName: string;
  model?: string;
}

const DEFAULT_MODEL = "gemini-3-flash-preview";

function getGeminiContextSize(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes("flash")) return 1_000_000;
  if (lower.includes("pro")) return 2_000_000;
  return 32000;
}

/**
 * @brief Converts ChatMessages to Gemini contents format.
 * @param messages - Chat messages
 * @returns Array of { role, parts } for Gemini API
 */
function toGeminiContents(messages: ChatMessage[]): Array<{ role: string; parts: Array<{ text: string }> }> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  let systemText = "";

  for (const m of messages) {
    if (m.role === "system") {
      systemText += (systemText ? "\n\n" : "") + m.content;
      continue;
    }
    if (m.role === "tool") continue; // Gemini doesn't support tool role in same way

    const role = m.role === "assistant" ? "model" : "user";
    const text = systemText && role === "user" ? `${systemText}\n\n${m.content}` : m.content;
    if (systemText && role === "user") systemText = ""; // Only prepend to first user msg
    contents.push({ role, parts: [{ text }] });
  }
  return contents;
}

/**
 * @brief Maps ToolDefinition[] to Gemini tools array (functionDeclarations).
 * @param tools - Maia tool definitions
 * @returns Gemini API tools payload
 */
function toGeminiTools(tools: ToolDefinition[]): Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }> {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? { type: "object", properties: {} },
      })),
    },
  ];
}

/**
 * @brief Parses Gemini response parts into content and toolCalls.
 * @param parts - response candidates[0].content.parts
 * @returns { content, toolCalls }
 */
function parseGeminiResponseParts(
  parts: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> | undefined
): { content: string; toolCalls: ToolCall[] } {
  let content = "";
  const toolCalls: ToolCall[] = [];
  if (!parts) return { content, toolCalls };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.text != null) content += p.text;
    if (p.functionCall?.name) {
      toolCalls.push({
        id: `gemini-${i}`,
        name: p.functionCall.name,
        arguments: (p.functionCall.args as Record<string, unknown>) ?? {},
      });
    }
  }
  return { content, toolCalls };
}

/**
 * @brief Creates a Gemini LLM provider.
 * @param deps - Dependencies: http, credentials, logger, credentialName, optional model
 * @returns LLMProvider implementation for Gemini
 */
export function createGeminiProvider(deps: GeminiProviderDeps) {
  const { http, credentials, logger, credentialName, model = DEFAULT_MODEL } =
    deps;
  const id = "gemini";
  const name = "Gemini";

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

      const contents = toGeminiContents(messages);

      const url = `${BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const payload: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: options?.temperature,
          maxOutputTokens: options?.maxTokens,
        },
      };
      if (options?.tools && options.tools.length > 0) {
        payload.tools = toGeminiTools(options.tools);
      }
      const body = JSON.stringify(payload);

      try {
        const res = await http.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: options?.signal,
        });

        if (!res.ok) {
          throw new Error(`Gemini API error: ${res.status} ${res.body}`);
        }

        const data = JSON.parse(res.body) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
          }>;
        };

        const parts = data.candidates?.[0]?.content?.parts;
        const { content: text, toolCalls } = parseGeminiResponseParts(parts);
        yield { content: text, done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Gemini chat failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      const cred = await credentials.get(credentialName);
      const key = cred.value;

      try {
        const res = await http.fetch(
          `${BASE_URL}/models?key=${encodeURIComponent(key)}`,
          { method: "GET" }
        );

        if (!res.ok) {
          throw new Error(`Gemini list models error: ${res.status} ${res.body}`);
        }

        const data = JSON.parse(res.body) as {
          models?: Array<{ name: string; displayName?: string }>;
        };
        const models = data.models ?? [];

        return models.map((m) => {
          const modelId = m.name.replace("models/", "");
          return {
            id: modelId,
            name: m.displayName ?? modelId,
            contextWindow: getGeminiContextSize(modelId),
          };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Gemini listModels failed", { error: msg });
        throw new ProviderError(id, msg);
      }
    },

    async healthCheck(): Promise<boolean> {
      try {
        const cred = await credentials.get(credentialName);
        const key = cred.value;

        const res = await http.fetch(
          `${BASE_URL}/models?key=${encodeURIComponent(key)}`,
          { method: "GET" }
        );
        return res.status === 200;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Gemini health check failed", { error: msg });
        return false;
      }
    },

    contextWindowSize(modelId: string): number {
      return getGeminiContextSize(modelId);
    },
  };
}
