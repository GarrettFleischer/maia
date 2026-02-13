/**
 * @fileoverview Credential vault integrity health check.
 * @module watchdog/health-checks/credentials
 *
 * @note Verifies that the credential vault is accessible and that all
 * credentials referenced by the configuration actually exist in the vault.
 */

import type { CredentialStore, Logger, MaiaConfig } from "../../core/types.js";
import type { HealthCheckResult } from "./config.js";

/**
 * @brief Dependencies for createCredentialHealthCheck.
 */
export interface CredentialHealthCheckDeps {
  credentials: CredentialStore;
  config: MaiaConfig;
  logger: Logger;
}

/**
 * @brief Creates a credential vault integrity health check.
 * @param deps - Dependencies: credentials, config, logger
 * @returns Function that checks vault integrity and returns a result
 *
 * @example
 * const check = createCredentialHealthCheck({ credentials, config, logger });
 * const result = await check();
 */
export function createCredentialHealthCheck(
  deps: CredentialHealthCheckDeps
): () => Promise<HealthCheckResult> {
  const { credentials, config, logger } = deps;

  return async (): Promise<HealthCheckResult> => {
    const missing: string[] = [];

    // Collect all credential names referenced in config
    const requiredCredentials: string[] = [];

    if (config.provider.groq?.credentialName) {
      requiredCredentials.push(config.provider.groq.credentialName);
    }
    if (config.provider.gemini?.credentialName) {
      requiredCredentials.push(config.provider.gemini.credentialName);
    }
    if (config.provider.huggingface?.credentialName) {
      requiredCredentials.push(config.provider.huggingface.credentialName);
    }
    if (config.provider.openrouter?.credentialName) {
      requiredCredentials.push(config.provider.openrouter.credentialName);
    }
    if (config.channels.discord.enabled && config.channels.discord.credentialName) {
      requiredCredentials.push(config.channels.discord.credentialName);
    }
    if (config.channels.telegram.enabled && config.channels.telegram.credentialName) {
      requiredCredentials.push(config.channels.telegram.credentialName);
    }

    // Check each required credential
    for (const name of requiredCredentials) {
      try {
        const exists = await credentials.has(name);
        if (!exists) {
          missing.push(name);
        }
      } catch (err) {
        missing.push(name);
        logger.warn("Failed to check credential", {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Also verify vault is accessible by listing
    try {
      await credentials.list();
    } catch (err) {
      return {
        name: "credentials",
        healthy: false,
        message: `Credential vault is inaccessible: ${err instanceof Error ? err.message : String(err)}`,
        details: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    const healthy = missing.length === 0;
    const message = healthy
      ? `Vault accessible, all ${requiredCredentials.length} required credentials present`
      : `${missing.length} required credential(s) missing from vault`;

    if (!healthy) {
      logger.warn("Credential health check issues", { missing });
    }

    return {
      name: "credentials",
      healthy,
      message,
      details: { required: requiredCredentials, missing },
    };
  };
}
