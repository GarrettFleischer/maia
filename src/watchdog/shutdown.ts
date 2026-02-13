/**
 * @fileoverview Emergency shutdown handler for the watchdog.
 * @module watchdog/shutdown
 *
 * @note Provides an emergency shutdown mechanism that is separate from the
 * graceful shutdown coordinator. This is used when the watchdog detects a
 * critical threat and needs to halt the system immediately.
 */

import type { AuditLog, Logger, ShutdownCoordinator } from "../core/types.js";

/**
 * @brief Dependencies for createEmergencyShutdown.
 */
export interface EmergencyShutdownDeps {
  shutdownCoordinator: ShutdownCoordinator;
  auditLog: AuditLog;
  logger: Logger;
}

/**
 * @brief Emergency shutdown handler interface.
 */
export interface EmergencyShutdown {
  /**
   * @brief Triggers an emergency shutdown.
   * @param reason - Description of why the shutdown was triggered
   * @param metadata - Additional context about the threat
   * @returns Promise resolving when shutdown sequence is initiated
   */
  trigger(reason: string, metadata?: Record<string, unknown>): Promise<void>;

  /**
   * @brief Returns whether an emergency shutdown has been triggered.
   * @returns true if shutdown was triggered
   */
  wasTriggered(): boolean;
}

/**
 * @brief Creates an emergency shutdown handler.
 * @param deps - Dependencies: shutdownCoordinator, auditLog, logger
 * @returns EmergencyShutdown instance
 *
 * @example
 * const emergency = createEmergencyShutdown({ shutdownCoordinator, auditLog, logger });
 * // On critical threat:
 * await emergency.trigger("Brute force attack detected", { ip: "1.2.3.4", attempts: 100 });
 */
export function createEmergencyShutdown(deps: EmergencyShutdownDeps): EmergencyShutdown {
  const { shutdownCoordinator, auditLog, logger } = deps;
  let triggered = false;

  return {
    async trigger(reason: string, metadata?: Record<string, unknown>): Promise<void> {
      if (triggered) {
        logger.warn("Emergency shutdown already triggered, ignoring duplicate", { reason });
        return;
      }

      triggered = true;
      logger.error("EMERGENCY SHUTDOWN triggered", { reason, ...metadata });

      // Log to audit trail
      await auditLog.log("SHUTDOWN", {
        type: "emergency",
        reason,
        ...metadata,
      });

      // Initiate graceful shutdown with emergency reason
      await shutdownCoordinator.shutdown(`EMERGENCY: ${reason}`);
    },

    wasTriggered(): boolean {
      return triggered;
    },
  };
}
