/**
 * @fileoverview Graceful shutdown coordinator.
 * @module core/shutdown
 *
 * @note Manages ordered shutdown of all registered modules. Hooks run in
 * reverse priority order (highest first). If a hook throws, the coordinator
 * logs the error and continues with remaining hooks.
 */

import type { Logger, ShutdownCoordinator, ShutdownHook } from "./types.js";

/**
 * @brief Options for createShutdownCoordinator.
 */
export interface ShutdownCoordinatorOptions {
  /** Optional logger for structured error reporting during shutdown */
  logger?: Logger;
}

/**
 * @brief Creates a shutdown coordinator that manages graceful shutdown.
 * @param options - Optional configuration including a logger
 * @returns ShutdownCoordinator instance
 *
 * @example
 * const coordinator = createShutdownCoordinator({ logger });
 * coordinator.register("database", async (reason) => { await db.close(); }, 5);
 * coordinator.register("gateway", async (reason) => { server.close(); }, 10);
 * await coordinator.shutdown("SIGINT"); // gateway first (priority 10), then db (priority 5)
 */
export function createShutdownCoordinator(options?: ShutdownCoordinatorOptions): ShutdownCoordinator {
  const hooks: Array<{ name: string; hook: ShutdownHook; priority: number }> = [];
  let shuttingDown = false;
  const logger = options?.logger;

  return {
    register(name: string, hook: ShutdownHook, priority?: number): void {
      hooks.push({ name, hook, priority: priority ?? 0 });
    },

    async shutdown(reason: string): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;

      // Sort by priority descending (highest first)
      const sorted = [...hooks].sort((a, b) => b.priority - a.priority);

      for (const { name, hook } of sorted) {
        try {
          await hook(reason);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (logger) {
            logger.error(`Shutdown hook "${name}" failed`, { error: msg, reason });
          } else {
            // Fallback when no logger is available
            console.error(`Shutdown hook "${name}" failed: ${msg}`);
          }
        }
      }
    },

    isShuttingDown(): boolean {
      return shuttingDown;
    },
  };
}
