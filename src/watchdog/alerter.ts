/**
 * @fileoverview Alert dispatcher for the watchdog. Routes alerts to configured
 * channels (console, discord, telegram, webhook) and optionally triggers shutdown.
 * @module watchdog/alerter
 */

import type {
  Logger,
  ShutdownCoordinator,
  WatchdogAlert,
} from "../core/types.js";

/** @brief Dependencies for createAlerter */
export interface AlerterDeps {
  channels: string[];
  logger: Logger;
  shutdownCoordinator?: ShutdownCoordinator;
  autoShutdown?: boolean;
}

/** @brief Alerter interface */
export interface Alerter {
  dispatch(alert: WatchdogAlert): Promise<void>;
}

/**
 * @brief Creates an alerter that dispatches watchdog alerts to configured channels.
 * @param deps - Dependencies: channels, logger, shutdownCoordinator (optional), autoShutdown (optional)
 * @returns Object implementing the Alerter interface
 */
export function createAlerter(deps: AlerterDeps): Alerter {
  const {
    channels,
    logger,
    shutdownCoordinator,
    autoShutdown = false,
  } = deps;

  async function dispatch(alert: WatchdogAlert): Promise<void> {
    if (alert.level === "CRITICAL" && autoShutdown && shutdownCoordinator) {
      await shutdownCoordinator.shutdown(
        "watchdog-critical: " + alert.pattern
      );
    }

    for (const channel of channels) {
      if (channel === "console") {
        const logMeta = { pattern: alert.pattern, ...alert.metadata };
        if (alert.level === "WARN") {
          logger.warn(alert.message, logMeta);
        } else if (alert.level === "CRITICAL") {
          logger.error(alert.message, logMeta);
        } else {
          logger.info(alert.message, logMeta);
        }
      } else if (
        channel === "discord" ||
        channel === "telegram" ||
        channel === "webhook"
      ) {
        logger.info(
          `[${channel}] Would send alert: ${alert.pattern} - ${alert.message}`,
          { level: alert.level, metadata: alert.metadata }
        );
      }
    }
  }

  return { dispatch };
}
