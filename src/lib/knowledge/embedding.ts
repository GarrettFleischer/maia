/**
 * @fileoverview Embedding adapter for knowledge base and history semantic search.
 * @module lib/knowledge/embedding
 *
 * Uses Ollama /api/embeddings (e.g. nomic-embed-text) by default.
 */

import type { HttpClient } from "../context";
import type { Settings } from "../types";

export interface EmbeddingAdapter {
  /** Embed a single text and return the vector. */
  embed(text: string): Promise<number[]>;
}

/**
 * Ollama embedding adapter. Calls POST {baseUrl}/api/embeddings.
 * @param model - Model name (e.g. nomic-embed-text)
 * @param baseUrl - Ollama base URL (e.g. http://localhost:11434)
 * @param http - HTTP client
 */
export function createOllamaEmbeddingAdapter(
  model: string,
  baseUrl: string,
  http: HttpClient
): EmbeddingAdapter {
  const url = `${baseUrl.replace(/\/$/, "")}/api/embeddings`;

  return {
    async embed(text: string): Promise<number[]> {
      const res = await http.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama embeddings failed (${res.status}): ${body}`);
      }
      const data = (await res.json()) as { embeddings?: number[][] };
      const embeddings = data.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length === 0 || !Array.isArray(embeddings[0])) {
        throw new Error("Ollama embeddings: invalid response shape");
      }
      return embeddings[0];
    },
  };
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
