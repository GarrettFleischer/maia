/**
 * @fileoverview Graceful shutdown coordinator.
 * @module core/shutdown
 *
 * @note Manages ordered shutdown of all registered modules. Hooks run in
 * reverse priority order (highest first). If a hook throws, the coordinator
 * logs the error and continues with remaining hooks.
 */

import type { ShutdownCoordinator, ShutdownHook } from "./types.js";

/**
 * @brief Creates a shutdown coordinator that manages graceful shutdown.
 * @returns ShutdownCoordinator instance
 *
 * @example
 * const coordinator = createShutdownCoordinator();
 * coordinator.register("database", async (reason) => { await db.close(); }, 5);
 * coordinator.register("gateway", async (reason) => { server.close(); }, 10);
 * await coordinator.shutdown("SIGINT"); // gateway first (priority 10), then db (priority 5)
 */
export function createShutdownCoordinator(): ShutdownCoordinator {
  const hooks: Array<{ name: string; hook: ShutdownHook; priority: number }> = [];
  let shuttingDown = false;

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
        } catch {
          // Log error but continue shutdown
          console.error(`Shutdown hook "${name}" failed`);
        }
      }
    },

    isShuttingDown(): boolean {
      return shuttingDown;
    },
  };
}
