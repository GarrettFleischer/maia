/**
 * @fileoverview Unit tests for the watchdog daemon: threat detection, alerting, shutdown.
 * @module tests/unit/watchdog/watchdog
 */

import { describe, it, expect } from "bun:test";
import { createThreatDetector } from "../../../src/watchdog/threat-detector.js";
import { createAlerter } from "../../../src/watchdog/alerter.js";
import { fixedClock, capturingLogger, mockShutdownCoordinator } from "../../helpers/index.js";
import type { AuditEntry, AlertLevel } from "../../../src/core/types.js";

describe("Threat Detector", () => {
  function makeDetector() {
    const clock = fixedClock(new Date("2026-02-13T14:00:00.000Z"));
    const detector = createThreatDetector({
      clock,
      windowDurationMs: 300000,
      bruteForceThreshold: 3,
      injectionThreshold: 2,
    });
    return { detector, clock };
  }

  it("should detect brute force pattern", () => {
    const { detector } = makeDetector();
    const events: AuditEntry[] = [
      { timestamp: "2026-02-13T13:58:00Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
      { timestamp: "2026-02-13T13:59:00Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
      { timestamp: "2026-02-13T13:59:30Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
    ];

    const threats = detector.analyze(events);
    expect(threats.length).toBeGreaterThan(0);
    expect(threats[0].pattern).toContain("brute_force");
  });

  it("should detect injection storm pattern", () => {
    const { detector } = makeDetector();
    const events: AuditEntry[] = [
      { timestamp: "2026-02-13T13:58:00Z", type: "INJECTION_DETECTED", metadata: { channel: "discord" } },
      { timestamp: "2026-02-13T13:59:00Z", type: "INJECTION_DETECTED", metadata: { channel: "discord" } },
    ];

    const threats = detector.analyze(events);
    expect(threats.length).toBeGreaterThan(0);
    expect(threats[0].pattern).toContain("injection_storm");
  });

  it("should not alert for events below threshold", () => {
    const { detector } = makeDetector();
    const events: AuditEntry[] = [
      { timestamp: "2026-02-13T13:59:00Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
    ];

    const threats = detector.analyze(events);
    expect(threats).toHaveLength(0);
  });

  it("should ignore events outside the time window", () => {
    const { detector } = makeDetector();
    const events: AuditEntry[] = [
      { timestamp: "2026-02-13T13:00:00Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
      { timestamp: "2026-02-13T13:01:00Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
      { timestamp: "2026-02-13T13:02:00Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
    ];

    const threats = detector.analyze(events);
    // All events are > 5 minutes old, so no threat
    expect(threats).toHaveLength(0);
  });

  it("should assign appropriate alert levels", () => {
    const { detector } = makeDetector();
    const events: AuditEntry[] = [
      { timestamp: "2026-02-13T13:58:00Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
      { timestamp: "2026-02-13T13:59:00Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
      { timestamp: "2026-02-13T13:59:30Z", type: "AUTH_FAILURE", metadata: { ip: "1.2.3.4" } },
    ];

    const threats = detector.analyze(events);
    expect(["WARN", "CRITICAL"]).toContain(threats[0].level);
  });
});

describe("Alerter", () => {
  it("should dispatch alerts to console", () => {
    const logger = capturingLogger();
    const alerter = createAlerter({
      channels: ["console"],
      logger,
    });

    alerter.dispatch({
      level: "WARN" as AlertLevel,
      pattern: "brute_force",
      message: "Multiple auth failures from 1.2.3.4",
      timestamp: "2026-02-13T14:00:00Z",
      metadata: {},
    });

    const warnLogs = logger.calls.filter((c) => c.level === "warn");
    expect(warnLogs.length).toBeGreaterThanOrEqual(1);
  });

  it("should trigger shutdown on CRITICAL alert when enabled", async () => {
    const logger = capturingLogger();
    const shutdown = mockShutdownCoordinator();
    const alerter = createAlerter({
      channels: ["console"],
      logger,
      shutdownCoordinator: shutdown,
      autoShutdown: true,
    });

    await alerter.dispatch({
      level: "CRITICAL" as AlertLevel,
      pattern: "credential_probing",
      message: "Credential probing detected",
      timestamp: "2026-02-13T14:00:00Z",
      metadata: {},
    });

    expect(shutdown.shutdownCalled).toBe(true);
  });

  it("should NOT trigger shutdown on WARN alert", async () => {
    const logger = capturingLogger();
    const shutdown = mockShutdownCoordinator();
    const alerter = createAlerter({
      channels: ["console"],
      logger,
      shutdownCoordinator: shutdown,
      autoShutdown: true,
    });

    await alerter.dispatch({
      level: "WARN" as AlertLevel,
      pattern: "brute_force",
      message: "Auth failures",
      timestamp: "2026-02-13T14:00:00Z",
      metadata: {},
    });

    expect(shutdown.shutdownCalled).toBe(false);
  });
});
