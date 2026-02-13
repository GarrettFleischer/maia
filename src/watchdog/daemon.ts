/**
 * @fileoverview Main watchdog daemon process.
 * @module watchdog/daemon
 *
 * @note The watchdog daemon runs alongside the main gateway process,
 * orchestrating audit log monitoring, periodic health checks, and
 * emergency shutdown when critical threats are detected.
 *
 * The daemon lifecycle:
 * 1. Initialize all health checks
 * 2. Start the audit log monitor
 * 3. Run periodic health checks at the configured interval
 * 4. Report results and trigger alerts as needed
 * 5. Shut down cleanly on signal or emergency
 */

import type { MaiaContext, Logger } from "../core/types.js";
import type { ThreatDetector } from "./threat-detector.js";
import type { Alerter } from "./alerter.js";
import type { AuditMonitor } from "./monitor.js";
import type { EmergencyShutdown } from "./shutdown.js";
import type { HealthCheckResult } from "./health-checks/config.js";

/**
 * @brief Dependencies for createWatchdogDaemon.
 */
export interface WatchdogDaemonDeps {
  ctx: MaiaContext;
  threatDetector: ThreatDetector;
  alerter: Alerter;
  auditMonitor: AuditMonitor;
  emergencyShutdown: EmergencyShutdown;
  healthChecks: Array<() => Promise<HealthCheckResult>>;
  /** Health check interval in milliseconds */
  healthCheckIntervalMs: number;
}

/**
 * @brief Watchdog daemon interface.
 */
export interface WatchdogDaemon {
  /**
   * @brief Starts the watchdog daemon.
   * @returns Promise resolving when the daemon is running
   */
  start(): Promise<void>;

  /**
   * @brief Stops the watchdog daemon.
   * @returns Promise resolving when the daemon is stopped
   */
  stop(): Promise<void>;

  /**
   * @brief Runs all health checks immediately.
   * @returns Promise resolving to array of health check results
   */
  runHealthChecks(): Promise<HealthCheckResult[]>;

  /**
   * @brief Returns whether the daemon is currently running.
   * @returns true if the daemon is active
   */
  isRunning(): boolean;
}

/**
 * @brief Creates the main watchdog daemon.
 * @param deps - All watchdog dependencies
 * @returns WatchdogDaemon instance
 *
 * @example
 * const daemon = createWatchdogDaemon({
 *   ctx, threatDetector, alerter, auditMonitor, emergencyShutdown,
 *   healthChecks: [configCheck, providerCheck, dbCheck, ...],
 *   healthCheckIntervalMs: 60000,
 * });
 * await daemon.start();
 */
export function createWatchdogDaemon(deps: WatchdogDaemonDeps): WatchdogDaemon {
  const {
    ctx,
    alerter,
    auditMonitor,
    healthChecks,
    healthCheckIntervalMs,
  } = deps;
  const logger: Logger = ctx.logger;

  let running = false;
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @brief Runs all registered health checks and dispatches alerts for failures.
   * @returns Array of health check results
   */
  async function runHealthChecks(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    for (const check of healthChecks) {
      try {
        const result = await check();
        results.push(result);

        if (!result.healthy) {
          await alerter.dispatch({
            level: "WARN",
            pattern: `health_check_failed:${result.name}`,
            message: result.message,
            timestamp: ctx.clock.timestamp(),
            metadata: result.details ?? {},
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("Health check threw an exception", { error: errorMsg });
        results.push({
          name: "unknown",
          healthy: false,
          message: `Health check exception: ${errorMsg}`,
        });
      }
    }

    await ctx.auditLog.log("HEALTH_CHECK", {
      total: results.length,
      healthy: results.filter((r) => r.healthy).length,
      unhealthy: results.filter((r) => !r.healthy).length,
    });

    return results;
  }

  return {
    async start(): Promise<void> {
      if (running) return;

      running = true;
      logger.info("Watchdog daemon starting");

      // Start audit log monitoring
      auditMonitor.start();

      // Run initial health checks
      const initialResults = await runHealthChecks();
      const failedCount = initialResults.filter((r) => !r.healthy).length;
      if (failedCount > 0) {
        logger.warn("Watchdog initial health check found issues", {
          failed: failedCount,
          total: initialResults.length,
        });
      }

      // Start periodic health checks
      healthCheckTimer = setInterval(() => {
        void runHealthChecks();
      }, healthCheckIntervalMs);

      // Register shutdown hook
      ctx.shutdown.register("watchdog", async (_reason: string) => {
        await this.stop();
      });

      logger.info("Watchdog daemon started", {
        healthCheckIntervalMs,
        healthChecks: healthChecks.length,
      });
    },

    async stop(): Promise<void> {
      if (!running) return;

      running = false;

      // Stop health check timer
      if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
      }

      // Stop audit monitor
      auditMonitor.stop();

      logger.info("Watchdog daemon stopped");
    },

    async runHealthChecks(): Promise<HealthCheckResult[]> {
      return runHealthChecks();
    },

    isRunning(): boolean {
      return running;
    },
  };
}
