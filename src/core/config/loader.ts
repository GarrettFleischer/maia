/**
 * @fileoverview Configuration loader with environment variable substitution.
 * @module core/config/loader
 *
 * @note Loads config from a JSON file, substitutes ${VAR_NAME} patterns with
 * environment variables, then validates against the Zod schema.
 */

import type { MaiaConfig, MaiaContext } from "../types.js";
import { configSchema } from "./schema.js";
import { ConfigError } from "../errors.js";

/**
 * @brief Substitutes ${VAR_NAME} patterns in a string with environment values.
 * @param text - Raw config text
 * @param env - Environment provider
 * @returns Text with env vars substituted
 * @throws ConfigError if a referenced env var is not defined
 */
function substituteEnvVars(
  text: string,
  env: { get(key: string): string | undefined }
): string {
  return text.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    const value = env.get(varName);
    if (value === undefined) {
      throw new ConfigError(`Environment variable ${varName} is not defined`);
    }
    return value;
  });
}

/**
 * @brief Loads and validates configuration from a file.
 * @param configPath - Path to the JSON config file
 * @param ctx - Context providing fs and env dependencies
 * @returns Validated MaiaConfig
 * @throws ConfigError on missing file, invalid JSON, or validation failure
 *
 * @example
 * const config = await loadConfig("/home/user/.maia/config.json", ctx);
 */
export async function loadConfig(
  configPath: string,
  ctx: Pick<MaiaContext, "fs" | "env" | "logger">
): Promise<MaiaConfig> {
  // Read config file
  let raw: string;
  try {
    raw = await ctx.fs.readFile(configPath);
  } catch {
    throw new ConfigError(`Config file not found: ${configPath}`);
  }

  // Substitute environment variables
  const substituted = substituteEnvVars(raw, ctx.env);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(substituted);
  } catch {
    throw new ConfigError(`Invalid JSON in config file: ${configPath}`);
  }

  // Validate against schema
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Config validation failed:\n${issues}`);
  }

  return result.data as MaiaConfig;
}
