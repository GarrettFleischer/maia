/**
 * @fileoverview Configuration validation health check.
 * @module watchdog/health-checks/config
 *
 * @note Validates that the running configuration is consistent and
 * that required settings are present. Reports warnings for common
 * misconfigurations.
 */

import type { Logger, MaiaConfig } from "../../core/types.js";

/**
 * @brief Health check result.
 */
export interface HealthCheckResult {
  name: string;
  healthy: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * @brief Dependencies for createConfigHealthCheck.
 */
export interface ConfigHealthCheckDeps {
  config: MaiaConfig;
  logger: Logger;
}

/**
 * @brief Creates a configuration validation health check.
 * @param deps - Dependencies: config, logger
 * @returns Function that runs the health check and returns a result
 *
 * @example
 * const check = createConfigHealthCheck({ config, logger });
 * const result = await check();
 * // result.healthy === true if all critical config is valid
 */
export function createConfigHealthCheck(
  deps: ConfigHealthCheckDeps
): () => Promise<HealthCheckResult> {
  const { config, logger } = deps;

  return async (): Promise<HealthCheckResult> => {
    const warnings: string[] = [];

    // Check auth token
    if (!config.gateway.auth.token || config.gateway.auth.token.length < 16) {
      warnings.push("Auth token is missing or too short (min 16 chars recommended)");
    }

    // Check primary provider
    if (!config.provider.primary) {
      warnings.push("No primary provider configured");
    }

    // Check workspace path
    if (!config.workspace.path) {
      warnings.push("Workspace path is empty");
    }

    // Check for default/insecure settings
    if (config.gateway.host === "0.0.0.0") {
      warnings.push("Gateway bound to all interfaces (0.0.0.0) — consider restricting to 127.0.0.1");
    }

    const healthy = warnings.length === 0;
    const message = healthy
      ? "Configuration is valid"
      : `Configuration has ${warnings.length} warning(s)`;

    if (!healthy) {
      logger.warn("Config health check warnings", { warnings });
    }

    return {
      name: "config",
      healthy,
      message,
      details: { warnings },
    };
  };
}
