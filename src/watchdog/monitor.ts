/**
 * @fileoverview Real-time audit log monitor for the watchdog.
 * @module watchdog/monitor
 *
 * @note Polls the audit log at a configurable interval and feeds new events
 * to the threat detector. Discovered threats are dispatched via the alerter.
 */

import type { AuditLog, AuditEntry, Clock, Logger } from "../core/types.js";
import type { ThreatDetector } from "./threat-detector.js";
import type { Alerter } from "./alerter.js";

/**
 * @brief Dependencies for createAuditMonitor.
 */
export interface AuditMonitorDeps {
  auditLog: AuditLog;
  threatDetector: ThreatDetector;
  alerter: Alerter;
  clock: Clock;
  logger: Logger;
  /** Polling interval in milliseconds */
  pollIntervalMs: number;
}

/**
 * @brief Audit monitor interface.
 */
export interface AuditMonitor {
  /**
   * @brief Starts the audit log polling loop.
   */
  start(): void;

  /**
   * @brief Stops the polling loop.
   */
  stop(): void;

  /**
   * @brief Runs a single poll cycle (for testing).
   * @returns Promise resolving when the cycle completes
   */
  pollOnce(): Promise<void>;

  /**
   * @brief Returns whether the monitor is currently running.
   * @returns true if running
   */
  isRunning(): boolean;
}

/**
 * @brief Creates an audit log monitor that polls for threats.
 * @param deps - Dependencies: auditLog, threatDetector, alerter, clock, logger, pollIntervalMs
 * @returns AuditMonitor instance
 *
 * @example
 * const monitor = createAuditMonitor({
 *   auditLog, threatDetector, alerter, clock, logger,
 *   pollIntervalMs: 5000,
 * });
 * monitor.start();
 */
export function createAuditMonitor(deps: AuditMonitorDeps): AuditMonitor {
  const { auditLog, threatDetector, alerter, clock, logger, pollIntervalMs } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPollTime: Date | null = null;
  let running = false;

  async function pollOnce(): Promise<void> {
    try {
      const since = lastPollTime ?? new Date(clock.now().getTime() - pollIntervalMs * 2);
      const events: AuditEntry[] = await auditLog.read({ since });
      lastPollTime = clock.now();

      if (events.length === 0) return;

      const alerts = threatDetector.analyze(events);
      for (const alert of alerts) {
        await alerter.dispatch(alert);
      }

      if (alerts.length > 0) {
        logger.info("Watchdog monitor detected threats", { count: alerts.length });
      }
    } catch (err) {
      logger.error("Watchdog monitor poll failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      timer = setInterval(() => {
        void pollOnce();
      }, pollIntervalMs);
      logger.info("Watchdog monitor started", { pollIntervalMs });
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
      logger.info("Watchdog monitor stopped");
    },

    async pollOnce(): Promise<void> {
      return pollOnce();
    },

    isRunning(): boolean {
      return running;
    },
  };
}
