/**
 * @fileoverview Threat detection for the watchdog. Analyzes audit events within a
 * sliding time window to detect brute-force attacks and injection storms.
 * @module watchdog/threat-detector
 */

import type { AuditEntry, Clock, WatchdogAlert } from "../core/types.js";

/** @brief Dependencies for createThreatDetector */
export interface ThreatDetectorDeps {
  clock: Clock;
  windowDurationMs: number;
  bruteForceThreshold: number;
  injectionThreshold: number;
}

/** @brief Threat detector interface */
export interface ThreatDetector {
  analyze(events: AuditEntry[]): WatchdogAlert[];
}

/**
 * @brief Creates a threat detector that analyzes audit events for security patterns.
 * @param deps - Dependencies: clock, windowDurationMs, bruteForceThreshold, injectionThreshold
 * @returns Object implementing the ThreatDetector interface
 */
export function createThreatDetector(deps: ThreatDetectorDeps): ThreatDetector {
  const { clock, windowDurationMs, bruteForceThreshold, injectionThreshold } =
    deps;

  function analyze(events: AuditEntry[]): WatchdogAlert[] {
    const now = clock.now().getTime();
    const windowStart = now - windowDurationMs;
    const alerts: WatchdogAlert[] = [];

    const inWindow = events.filter((e) => {
      const ts = new Date(e.timestamp).getTime();
      return ts >= windowStart;
    });

    const authFailuresByIp = new Map<string, number>();
    let injectionCount = 0;

    for (const e of inWindow) {
      if (e.type === "AUTH_FAILURE") {
        const ip = (e.metadata?.ip as string) ?? "unknown";
        authFailuresByIp.set(ip, (authFailuresByIp.get(ip) ?? 0) + 1);
      } else if (e.type === "INJECTION_DETECTED") {
        injectionCount++;
      }
    }

    for (const [ip, count] of authFailuresByIp) {
      if (count >= bruteForceThreshold) {
        alerts.push({
          level: "WARN",
          pattern: "brute_force",
          message: `Brute-force attempt detected: ${count} auth failures from IP ${ip} within window`,
          timestamp: clock.timestamp(),
          metadata: { ip, count },
        });
      }
    }

    if (injectionCount >= injectionThreshold) {
      alerts.push({
        level: "WARN",
        pattern: "injection_storm",
        message: `Injection storm detected: ${injectionCount} injection attempts within window`,
        timestamp: clock.timestamp(),
        metadata: { count: injectionCount },
      });
    }

    return alerts;
  }

  return { analyze };
}
