/**
 * @fileoverview Embedding provider abstraction for memory vector search.
 * @module memory/embeddings
 *
 * @note Wraps LLM providers that support embeddings behind a uniform interface.
 * Falls back to a simple bag-of-characters approach if no embedding provider is available.
 */

import type { LLMProvider, Logger } from "../core/types.js";

/**
 * @brief Embedding provider interface.
 */
export interface EmbeddingProvider {
  /**
   * @brief Generates embedding vectors for the given texts.
   * @param texts - Array of strings to embed
   * @returns Promise resolving to array of number arrays (one per input text)
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * @brief Dependencies for createEmbeddingProvider.
 */
export interface EmbeddingProviderDeps {
  provider?: LLMProvider;
  logger: Logger;
}

/**
 * @brief Creates an embedding provider that delegates to an LLM provider's embed() method.
 * @param deps - Dependencies: provider (optional LLM with embed support), logger
 * @returns EmbeddingProvider instance
 *
 * @note If the provider doesn't support embeddings, falls back to a simple
 * character-frequency hash that produces a deterministic 64-dimensional vector.
 * This fallback is suitable for basic similarity but not production quality.
 *
 * @example
 * const embedder = createEmbeddingProvider({ provider: ollamaProvider, logger });
 * const vectors = await embedder.embed(["Hello world", "Goodbye world"]);
 * // vectors[0].length === 64 (fallback) or provider-specific dimensions
 */
export function createEmbeddingProvider(deps: EmbeddingProviderDeps): EmbeddingProvider {
  const { provider, logger } = deps;

  /**
   * @brief Simple character-frequency fallback embedding.
   * @param text - Input text
   * @returns A 64-dimensional normalized vector
   *
   * @note This is NOT a production-quality embedding. It produces deterministic
   * vectors based on character frequencies, suitable for basic testing and
   * local-only setups without an embedding API.
   */
  function fallbackEmbed(text: string): number[] {
    const dimensions = 64;
    const vec = new Array<number>(dimensions).fill(0);
    const lower = text.toLowerCase();

    for (let i = 0; i < lower.length; i++) {
      const code = lower.charCodeAt(i);
      const bucket = code % dimensions;
      vec[bucket] += 1;
    }

    // L2 normalize
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dimensions; i++) {
        vec[i] = vec[i] / magnitude;
      }
    }

    return vec;
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (provider?.embed) {
        try {
          const result = await provider.embed(texts);
          logger.debug("Embeddings generated via provider", {
            provider: provider.id,
            count: texts.length,
          });
          return result;
        } catch (err) {
          logger.warn("Provider embedding failed, using fallback", {
            provider: provider.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Fallback: character-frequency embedding
      logger.debug("Using fallback character-frequency embedding", { count: texts.length });
      return texts.map(fallbackEmbed);
    },
  };
}
