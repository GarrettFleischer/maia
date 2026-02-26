/**
 * @fileoverview Embedding adapter for knowledge base and history semantic search.
 * @module lib/knowledge/embedding
 *
 * Uses Ollama /api/embed (e.g. nomic-embed-text) by default.
 */

import type { HttpClient } from "../context";
import type { Settings } from "../types";

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
      // #region agent log
      fetch("http://127.0.0.1:7245/ingest/13540c59-9d40-405a-a4df-e70acbf0e8f0", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "73f7a4" },
        body: JSON.stringify({
          sessionId: "73f7a4",
          location: "embedding.ts:embed",
          message: "Embed fetch attempt",
          data: { url, model, baseUrl },
          timestamp: Date.now(),
          hypothesisId: "H2",
        }),
      }).catch(() => {});
      // #endregion
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
 * Create the default embedding adapter from app settings.
 * @param settings - App settings (embeddingModel, ollamaBaseUrl)
 * @param http - HTTP client
 */
export function createEmbeddingAdapter(settings: Settings, http: HttpClient): EmbeddingAdapter {
  const model = (settings.embeddingModel ?? "nomic-embed-text").replace(/^ollama\//, "");
  return createOllamaEmbeddingAdapter(model, settings.ollamaBaseUrl, http);
}
