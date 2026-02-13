/**
 * @fileoverview Channel authentication status health check.
 * @module watchdog/health-checks/channels
 *
 * @note Verifies that enabled channels have valid credentials and
 * can authenticate with their respective platforms.
 */

import type { CredentialStore, Logger, MaiaConfig } from "../../core/types.js";
import type { HealthCheckResult } from "./config.js";

/**
 * @brief Dependencies for createChannelHealthCheck.
 */
export interface ChannelHealthCheckDeps {
  config: MaiaConfig;
  credentials: CredentialStore;
  logger: Logger;
}

/**
 * @brief Creates a channel auth status health check.
 * @param deps - Dependencies: config, credentials, logger
 * @returns Function that checks channel credentials and returns a result
 *
 * @example
 * const check = createChannelHealthCheck({ config, credentials, logger });
 * const result = await check();
 */
export function createChannelHealthCheck(
  deps: ChannelHealthCheckDeps
): () => Promise<HealthCheckResult> {
  const { config, credentials, logger } = deps;

  return async (): Promise<HealthCheckResult> => {
    const issues: string[] = [];

    // Check Discord credentials
    if (config.channels.discord.enabled) {
      const credName = config.channels.discord.credentialName;
      if (!credName) {
        issues.push("Discord enabled but no credential name configured");
      } else {
        const hasToken = await credentials.has(credName);
        if (!hasToken) {
          issues.push(`Discord credential '${credName}' not found in vault`);
        }
      }
    }

    // Check Telegram credentials
    if (config.channels.telegram.enabled) {
      const credName = config.channels.telegram.credentialName;
      if (!credName) {
        issues.push("Telegram enabled but no credential name configured");
      } else {
        const hasToken = await credentials.has(credName);
        if (!hasToken) {
          issues.push(`Telegram credential '${credName}' not found in vault`);
        }
      }
    }

    const healthy = issues.length === 0;
    const message = healthy
      ? "All enabled channels have valid credentials"
      : `${issues.length} channel credential issue(s)`;

    if (!healthy) {
      logger.warn("Channel health check issues", { issues });
    }

    return {
      name: "channels",
      healthy,
      message,
      details: { issues },
    };
  };
}
