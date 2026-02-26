/**
 * @fileoverview Embedding adapter for knowledge base and history semantic search.
 * @module lib/knowledge/embedding
 *
 * Uses Ollama /api/embed (e.g. nomic-embed-text) by default.
 * Context length for chunking is obtained via Ollama POST /api/show and cached per model.
 */

import type { HttpClient } from "../context";
import type { Settings } from "../types";

/** Fallback context length in tokens when /api/show fails or has no num_ctx. */
const DEFAULT_CONTEXT_TOKENS = 2048;
/** Approximate characters per token for a safe chunk size. */
const CHARS_PER_TOKEN = 3;

const contextLengthCache = new Map<string, number>();

/**
 * Clears the context length cache. Only for use in tests.
 * @internal
 */
export function _clearOllamaEmbedContextLengthCacheForTests(): void {
  contextLengthCache.clear();
}

/**
 * Returns the maximum character length safe to send in a single embed request for the given model.
 * Queries Ollama POST /api/show, parses num_ctx from parameters, and caches per model.
 * @param model - Ollama model name (e.g. nomic-embed-text)
 * @param baseUrl - Ollama base URL (e.g. http://localhost:11434)
 * @param http - HTTP client
 * @returns Safe character budget per chunk (tokens * CHARS_PER_TOKEN), or fallback 2048*3 on error
 */
export async function getOllamaEmbedContextLength(
  model: string,
  baseUrl: string,
  http: HttpClient,
): Promise<number> {
  const cacheKey = `${baseUrl.replace(/\/$/, "")}|${model}`;
  const cached = contextLengthCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${baseUrl.replace(/\/$/, "")}/api/show`;
  let tokens = DEFAULT_CONTEXT_TOKENS;
  try {
    const res = await http.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (res.ok) {
      const data = (await res.json()) as { parameters?: string; model_info?: Record<string, unknown> };
      if (typeof data.parameters === "string") {
        const match = data.parameters.match(/num_ctx\s+(\d+)/);
        if (match) tokens = Math.max(1, parseInt(match[1], 10));
      }
      if (tokens === DEFAULT_CONTEXT_TOKENS && data.model_info && typeof data.model_info === "object") {
        for (const [key, val] of Object.entries(data.model_info)) {
          if (key.toLowerCase().includes("context_length") && typeof val === "number" && val > 0 && val < 1_000_000) {
            tokens = val;
            break;
          }
        }
      }
    }
  } catch {
    // use fallback
  }
  const chars = tokens * CHARS_PER_TOKEN;
  contextLengthCache.set(cacheKey, chars);
  return chars;
}

export interface EmbeddingAdapter {
  /** Embed a single text and return the vector. */
  embed(text: string): Promise<number[]>;
}

/**
 * Ollama embedding adapter. Calls POST {baseUrl}/api/embed.
 * @param model - Model name (e.g. nomic-embed-text)
 * @param baseUrl - Ollama base URL (e.g. http://localhost:11434)
 * @param http - HTTP client
 */
export function createOllamaEmbeddingAdapter(
  model: string,
  baseUrl: string,
  http: HttpClient
): EmbeddingAdapter {
  const url = `${baseUrl.replace(/\/$/, "")}/api/embed`;

  return {
    async embed(text: string): Promise<number[]> {
      const res = await http.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        const body = await res.text();
        const hint =
          res.status === 404 && /not found.*try pulling/i.test(body)
            ? ` Run: ollama pull ${model}`
            : "";
        throw new Error(`Ollama embeddings failed (${res.status}): ${body}${hint}`);
      }
      const data = (await res.json()) as {
        embeddings?: number[][];
        embedding?: number[];
      };
      if (Array.isArray(data.embeddings) && data.embeddings.length > 0 && Array.isArray(data.embeddings[0])) {
        return data.embeddings[0];
      }
      if (Array.isArray(data.embedding) && data.embedding.length > 0) {
        return data.embedding;
      }
      throw new Error("Ollama embeddings: invalid response shape");
    },
  };
}

/**
 * Returns the effective maximum character length for a single embed chunk: the minimum of
 * settings.embedMaxContentLength and the model's context length from Ollama /api/show.
 * Use this when chunking long content to avoid "input length exceeds context length" errors.
 * @param settings - App settings (embeddingModel, ollamaBaseUrl, embedMaxContentLength)
 * @param http - HTTP client
 * @returns Safe character limit per chunk
 */
export async function getEffectiveEmbedMaxLength(
  settings: Settings,
  http: HttpClient,
): Promise<number> {
  const model = (settings.embeddingModel ?? "nomic-embed-text").replace(/^ollama\//, "");
  const ollamaMax = await getOllamaEmbedContextLength(model, settings.ollamaBaseUrl, http);
  return Math.min(settings.embedMaxContentLength, ollamaMax);
}

/**
 * Splits content into chunks of at most maxChars each (no word-boundary splitting).
 * @param content - Full text to chunk
 * @param maxChars - Maximum characters per chunk
 * @returns Array of chunks
 */
export function chunkContentForEmbedding(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += maxChars) {
    chunks.push(content.slice(i, i + maxChars));
  }
  return chunks;
}

/**
 * Create the default embedding adapter from app settings.
 * @param settings - App settings (embeddingModel, ollamaBaseUrl)
 * @param http - HTTP client
 */
export function createEmbeddingAdapter(settings: Settings, http: HttpClient): EmbeddingAdapter {
  const model = (settings.embeddingModel ?? "nomic-embed-text").replace(/^ollama\//, "");
  return createOllamaEmbeddingAdapter(model, settings.ollamaBaseUrl, http);
}
