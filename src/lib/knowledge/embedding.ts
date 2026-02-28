/**
 * @fileoverview Embedding adapter for knowledge base and history semantic search.
 * @module lib/knowledge/embedding
 *
 * Supports Ollama, OpenRouter, vLLM, and Docker providers. Context length for chunking
 * is obtained via Ollama POST /api/show for Ollama models; other providers use defaults.
 */

import type { HttpClient } from "../context";
import type { Settings } from "../types";

/** Default character limit for non-Ollama embedding models (e.g. OpenRouter 8k context). */
const DEFAULT_NON_OLLAMA_EMBED_CHARS = 16384;

/** Max chunks per batch for history indexing. Batches reduce API round trips. */
export const EMBED_BATCH_SIZE = 64;

/** Fallback context length in tokens when /api/show fails or has no num_ctx. */
const DEFAULT_CONTEXT_TOKENS = 2048;
/** Conservative characters per token so chunks stay under token limit (dense text). */
const CHARS_PER_TOKEN = 2;
/** Hard cap on chunk size so we never exceed typical embed API limits (e.g. 2048 tokens). */
const SAFE_EMBED_MAX_CHARS = DEFAULT_CONTEXT_TOKENS * CHARS_PER_TOKEN;

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
 * @returns Safe character budget per chunk (tokens * CHARS_PER_TOKEN), or fallback 2048*2 on error
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
  /** Embed multiple texts in one request. Returns one vector per input. Default uses sequential embed. */
  embedBatch?(texts: string[]): Promise<number[][]>;
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

  async function embedBatchImpl(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await http.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts, truncate: true }),
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
    if (Array.isArray(data.embeddings) && data.embeddings.length > 0) {
      return data.embeddings;
    }
    if (Array.isArray(data.embedding) && data.embedding.length > 0) {
      return [data.embedding];
    }
    throw new Error("Ollama embeddings: invalid response shape");
  }

  return {
    async embed(text: string): Promise<number[]> {
      const batch = await embedBatchImpl([text]);
      return batch[0];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return embedBatchImpl(texts);
    },
  };
}

/**
 * OpenRouter embedding adapter. Calls POST https://openrouter.ai/api/v1/embeddings (OpenAI format).
 * @param model - Model ID without prefix (e.g. qwen/qwen3-embedding-8b)
 * @param apiKey - OpenRouter API key
 * @param http - HTTP client
 * @returns Embedding adapter
 */
export function createOpenRouterEmbeddingAdapter(
  model: string,
  apiKey: string,
  http: HttpClient,
): EmbeddingAdapter {
  const url = "https://openrouter.ai/api/v1/embeddings";

  async function embedBatchImpl(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await http.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Maia Agent System",
      },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter embeddings failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embeddings = data.data?.map((d) => d.embedding).filter((e): e is number[] => Array.isArray(e) && e.length > 0);
    if (!embeddings || embeddings.length !== texts.length) {
      throw new Error("OpenRouter embeddings: invalid response shape");
    }
    return embeddings;
  }

  return {
    async embed(text: string): Promise<number[]> {
      const batch = await embedBatchImpl([text]);
      return batch[0];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return embedBatchImpl(texts);
    },
  };
}

/**
 * OpenAI-compatible embedding adapter for vLLM/Docker servers.
 * Calls POST {baseUrl}/embeddings with model and input.
 * @param model - Model ID without prefix (e.g. BAAI/bge-m3)
 * @param baseUrl - Server base URL (e.g. http://localhost:8000/v1)
 * @param http - HTTP client
 * @returns Embedding adapter
 */
export function createOpenAICompatibleEmbeddingAdapter(
  model: string,
  baseUrl: string,
  http: HttpClient,
): EmbeddingAdapter {
  const url = `${baseUrl.replace(/\/$/, "")}/embeddings`;

  async function embedBatchImpl(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await http.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embeddings failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embeddings = data.data?.map((d) => d.embedding).filter((e): e is number[] => Array.isArray(e) && e.length > 0);
    if (!embeddings || embeddings.length !== texts.length) {
      throw new Error("Embeddings: invalid response shape");
    }
    return embeddings;
  }

  return {
    async embed(text: string): Promise<number[]> {
      const batch = await embedBatchImpl([text]);
      return batch[0];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return embedBatchImpl(texts);
    },
  };
}

/**
 * Returns the effective maximum character length for a single embed chunk.
 * For Ollama: uses model context from /api/show. For other providers: uses a default.
 * @param settings - App settings (embeddingModel, ollamaBaseUrl, embedMaxContentLength)
 * @param http - HTTP client
 * @returns Safe character limit per chunk
 */
export async function getEffectiveEmbedMaxLength(
  settings: Settings,
  http: HttpClient,
): Promise<number> {
  const model = settings.embeddingModel ?? "ollama/nomic-embed-text";
  if (model.startsWith("ollama/")) {
    const bareModel = model.replace(/^ollama\//, "");
    const ollamaMax = await getOllamaEmbedContextLength(bareModel, settings.ollamaBaseUrl, http);
    const effective = Math.min(settings.embedMaxContentLength, ollamaMax);
    return Math.min(effective, SAFE_EMBED_MAX_CHARS);
  }
  return Math.min(settings.embedMaxContentLength, DEFAULT_NON_OLLAMA_EMBED_CHARS);
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
 * Create the embedding adapter from app settings.
 * Routes to Ollama, OpenRouter, vLLM, or Docker based on model prefix.
 * @param settings - App settings (embeddingModel, provider URLs/keys, whitelistedModels)
 * @param http - HTTP client
 * @returns Embedding adapter for the configured model
 * @throws Error if embedding model is not whitelisted or provider is unknown
 */
export function createEmbeddingAdapter(settings: Settings, http: HttpClient): EmbeddingAdapter {
  const model = settings.embeddingModel ?? "ollama/nomic-embed-text";
  if (!settings.whitelistedModels.includes(model)) {
    throw new Error(`Embedding model not whitelisted: ${model}`);
  }

  if (model.startsWith("ollama/")) {
    const bareModel = model.replace(/^ollama\//, "");
    return createOllamaEmbeddingAdapter(bareModel, settings.ollamaBaseUrl, http);
  }

  if (model.startsWith("openrouter/")) {
    if (!settings.openRouterApiKey) {
      throw new Error("OpenRouter API key required for embedding model");
    }
    const bareModel = model.replace(/^openrouter\//, "");
    return createOpenRouterEmbeddingAdapter(bareModel, settings.openRouterApiKey, http);
  }

  if (model.startsWith("vllm/")) {
    const bareModel = model.replace(/^vllm\//, "");
    return createOpenAICompatibleEmbeddingAdapter(bareModel, settings.vllmBaseUrl, http);
  }

  if (model.startsWith("docker/")) {
    const bareModel = model.replace(/^docker\//, "");
    return createOpenAICompatibleEmbeddingAdapter(bareModel, settings.dockerBaseUrl, http);
  }

  throw new Error(`Unknown embedding provider for: ${model}`);
}
