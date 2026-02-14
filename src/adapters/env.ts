/**
 * @fileoverview Real environment variable provider wrapping process.env.
 * @module adapters/env
 *
 * @note Returns values directly from the process environment.
 * Tests use staticEnv() from the test helpers instead.
 */

import type { EnvProvider } from "../core/types.js";

/**
 * @brief Creates a real environment variable provider.
 * @returns EnvProvider implementation backed by process.env
 *
 * @example
 * const env = createRealEnvProvider();
 * const token = env.get("MAIA_AUTH_TOKEN");
 */
export function createRealEnvProvider(): EnvProvider {
  return {
    /**
     * @brief Retrieves an environment variable value.
     * @param key - Environment variable name
     * @returns The value, or undefined if not set
     */
    get(key: string): string | undefined {
      return process.env[key];
    },
  };
}
