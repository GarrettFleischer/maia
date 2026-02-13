/**
 * @fileoverview Database health check.
 * @module watchdog/health-checks/database
 *
 * @note Verifies that the SQLite database is accessible and responsive
 * by executing a simple query. Reports the memory count as a sanity check.
 */

import type { Database, Logger } from "../../core/types.js";
import type { HealthCheckResult } from "./config.js";

/**
 * @brief Dependencies for createDatabaseHealthCheck.
 */
export interface DatabaseHealthCheckDeps {
  db: Database;
  logger: Logger;
}

/**
 * @brief Creates a database health check.
 * @param deps - Dependencies: db, logger
 * @returns Function that checks DB accessibility and returns a result
 *
 * @example
 * const check = createDatabaseHealthCheck({ db, logger });
 * const result = await check();
 * // result.details.memoryCount === 42
 */
export function createDatabaseHealthCheck(
  deps: DatabaseHealthCheckDeps
): () => Promise<HealthCheckResult> {
  const { db, logger } = deps;

  return async (): Promise<HealthCheckResult> => {
    try {
      // Simple connectivity test
      const rows = await db.query<{ count: number }>(
        "SELECT COUNT(*) as count FROM memories"
      );
      const count = rows[0]?.count ?? 0;

      return {
        name: "database",
        healthy: true,
        message: `Database accessible, ${count} memories stored`,
        details: { memoryCount: count },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("Database health check failed", { error: errorMsg });

      return {
        name: "database",
        healthy: false,
        message: `Database error: ${errorMsg}`,
        details: { error: errorMsg },
      };
    }
  };
}
