/**
 * @fileoverview Provider connectivity and latency health check.
 * @module watchdog/health-checks/providers
 *
 * @note Checks that configured LLM providers are reachable by calling
 * their healthCheck() method and measuring response time.
 */

import type { LLMProvider, Logger } from "../../core/types.js";
import type { HealthCheckResult } from "./config.js";

/**
 * @brief Dependencies for createProviderHealthCheck.
 */
export interface ProviderHealthCheckDeps {
  providers: LLMProvider[];
  logger: Logger;
  /** Maximum latency in ms before considering unhealthy */
  maxLatencyMs?: number;
}

/**
 * @brief Creates a provider connectivity health check.
 * @param deps - Dependencies: providers, logger, optional maxLatencyMs
 * @returns Function that checks all providers and returns a result
 *
 * @example
 * const check = createProviderHealthCheck({ providers: [ollamaProvider], logger });
 * const result = await check();
 */
export function createProviderHealthCheck(
  deps: ProviderHealthCheckDeps
): () => Promise<HealthCheckResult> {
  const { providers, logger, maxLatencyMs = 10000 } = deps;

  return async (): Promise<HealthCheckResult> => {
    if (providers.length === 0) {
      return {
        name: "providers",
        healthy: false,
        message: "No providers configured",
      };
    }

    const results: Array<{
      id: string;
      healthy: boolean;
      latencyMs: number;
      error?: string;
    }> = [];

    for (const provider of providers) {
      const start = Date.now();
      try {
        const ok = await provider.healthCheck();
        const latencyMs = Date.now() - start;
        results.push({
          id: provider.id,
          healthy: ok && latencyMs < maxLatencyMs,
          latencyMs,
        });
      } catch (err) {
        const latencyMs = Date.now() - start;
        results.push({
          id: provider.id,
          healthy: false,
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const healthyCount = results.filter((r) => r.healthy).length;
    const allHealthy = healthyCount === results.length;

    if (!allHealthy) {
      const unhealthy = results.filter((r) => !r.healthy);
      logger.warn("Provider health check failures", { unhealthy });
    }

    return {
      name: "providers",
      healthy: healthyCount > 0, // At least one provider must be healthy
      message: `${healthyCount}/${results.length} providers healthy`,
      details: { results },
    };
  };
}
