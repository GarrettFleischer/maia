/**
 * @fileoverview Provider registry for registering and retrieving LLM providers.
 * @module providers/base
 *
 * @brief Manages a map of LLM providers, supports primary provider lookup,
 * health-based fallback, and health status reporting.
 */

import type { MaiaContext, LLMProvider } from "../core/types.js";

/**
 * @brief Registry interface for LLM providers.
 */
export interface ProviderRegistry {
  /** Register a provider by its id. */
  register(provider: LLMProvider): void;
  /** Get a provider by id. Throws if not found. */
  get(id: string): LLMProvider;
  /** Get the primary provider (matches ctx.config.provider.primary). */
  getPrimary(): LLMProvider;
  /** Get the first healthy provider (primary first, then others). */
  getHealthy(): Promise<LLMProvider>;
  /** Get health status for all registered providers. */
  healthStatus(): Promise<Map<string, boolean>>;
}

/**
 * @brief Creates a provider registry bound to the given Maia context.
 * @param ctx - Maia context containing config (provider.primary) and other deps
 * @returns ProviderRegistry instance
 */
export function createProviderRegistry(ctx: MaiaContext): ProviderRegistry {
  const providers = new Map<string, LLMProvider>();

  return {
    register(provider: LLMProvider): void {
      providers.set(provider.id, provider);
    },

    get(id: string): LLMProvider {
      const provider = providers.get(id);
      if (!provider) {
        throw new Error(`Provider not found: ${id}`);
      }
      return provider;
    },

    getPrimary(): LLMProvider {
      const primaryId = ctx.config.provider.primary;
      return this.get(primaryId);
    },

    async getHealthy(): Promise<LLMProvider> {
      const primaryId = ctx.config.provider.primary;
      const order = [primaryId, ...[...providers.keys()].filter((k) => k !== primaryId)];

      for (const id of order) {
        const provider = providers.get(id);
        if (!provider) continue;
        const healthy = await provider.healthCheck();
        if (healthy) return provider;
      }

      throw new Error("No healthy provider available");
    },

    async healthStatus(): Promise<Map<string, boolean>> {
      const status = new Map<string, boolean>();
      for (const [id, provider] of providers) {
        status.set(id, await provider.healthCheck());
      }
      return status;
    },
  };
}
