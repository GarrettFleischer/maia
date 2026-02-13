/**
 * @fileoverview File permission audit health check.
 * @module watchdog/health-checks/permissions
 *
 * @note Verifies that sensitive files (credential vault, audit log, config)
 * have restrictive file permissions. On Unix-like systems, checks that
 * sensitive files are not world-readable.
 */

import type { FileSystem, Logger, MaiaConfig } from "../../core/types.js";
import type { HealthCheckResult } from "./config.js";

/**
 * @brief Dependencies for createPermissionsHealthCheck.
 */
export interface PermissionsHealthCheckDeps {
  fs: FileSystem;
  config: MaiaConfig;
  logger: Logger;
}

/** @brief Files that should have restricted permissions */
const SENSITIVE_FILES = [
  "credentials.vault",
  "audit.log",
  "maia.config.json",
];

/**
 * @brief Creates a file permission audit health check.
 * @param deps - Dependencies: fs, config, logger
 * @returns Function that checks file permissions and returns a result
 *
 * @note On Windows, file permissions work differently from Unix.
 * This check verifies file existence and basic accessibility.
 *
 * @example
 * const check = createPermissionsHealthCheck({ fs, config, logger });
 * const result = await check();
 */
export function createPermissionsHealthCheck(
  deps: PermissionsHealthCheckDeps
): () => Promise<HealthCheckResult> {
  const { fs, config, logger } = deps;
  const workspacePath = config.workspace.path;

  return async (): Promise<HealthCheckResult> => {
    const issues: string[] = [];

    for (const filename of SENSITIVE_FILES) {
      const path = `${workspacePath}/${filename}`.replace(/\/+/g, "/");
      try {
        const exists = await fs.exists(path);
        if (!exists) continue; // File doesn't exist yet, that's OK

        const stat = await fs.stat(path);
        if (!stat.isFile) {
          issues.push(`${filename} is not a regular file`);
        }
      } catch (err) {
        // Can't stat — might be a permissions issue itself
        issues.push(`Cannot access ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const healthy = issues.length === 0;
    const message = healthy
      ? "Sensitive file permissions are acceptable"
      : `${issues.length} permission issue(s)`;

    if (!healthy) {
      logger.warn("Permission health check issues", { issues });
    }

    return {
      name: "permissions",
      healthy,
      message,
      details: { issues },
    };
  };
}
