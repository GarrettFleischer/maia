/**
 * @fileoverview Workspace file integrity health check.
 * @module watchdog/health-checks/workspace
 *
 * @note Verifies that critical workspace files (SOUL.md, AGENTS.md, etc.)
 * exist and have not been tampered with. Optionally verifies checksums
 * against known-good values.
 */

import type { FileSystem, Logger, MaiaConfig } from "../../core/types.js";
import type { HealthCheckResult } from "./config.js";

/**
 * @brief Dependencies for createWorkspaceHealthCheck.
 */
export interface WorkspaceHealthCheckDeps {
  fs: FileSystem;
  config: MaiaConfig;
  logger: Logger;
  /** Known checksums for critical files (optional) */
  knownChecksums?: Record<string, string>;
}

/** @brief Critical workspace files that should always exist */
const CRITICAL_FILES = ["SOUL.md", "AGENTS.md", "USER.md", "IDENTITY.md"];

/**
 * @brief Creates a workspace file integrity health check.
 * @param deps - Dependencies: fs, config, logger, optional knownChecksums
 * @returns Function that checks workspace integrity and returns a result
 *
 * @example
 * const check = createWorkspaceHealthCheck({ fs, config, logger });
 * const result = await check();
 */
export function createWorkspaceHealthCheck(
  deps: WorkspaceHealthCheckDeps
): () => Promise<HealthCheckResult> {
  const { fs, config, logger, knownChecksums } = deps;
  const workspacePath = config.workspace.path;

  return async (): Promise<HealthCheckResult> => {
    const missing: string[] = [];
    const tampered: string[] = [];

    for (const filename of CRITICAL_FILES) {
      const path = `${workspacePath}/${filename}`.replace(/\/+/g, "/");
      const exists = await fs.exists(path);

      if (!exists) {
        missing.push(filename);
        continue;
      }

      // Checksum verification if provided
      if (knownChecksums?.[filename]) {
        try {
          const checksum = await fs.checksum(path);
          if (checksum !== knownChecksums[filename]) {
            tampered.push(filename);
          }
        } catch (err) {
          logger.warn("Failed to compute checksum", {
            filename,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const healthy = missing.length === 0 && tampered.length === 0;
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`${missing.length} missing`);
    if (tampered.length > 0) parts.push(`${tampered.length} tampered`);
    const message = healthy
      ? "All workspace files present and intact"
      : `Workspace issues: ${parts.join(", ")}`;

    if (!healthy) {
      logger.warn("Workspace health check issues", { missing, tampered });
    }

    return {
      name: "workspace",
      healthy,
      message,
      details: { missing, tampered },
    };
  };
}
