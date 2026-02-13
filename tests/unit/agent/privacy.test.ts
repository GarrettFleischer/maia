/**
 * @fileoverview Unit tests for privacy mode ("don't remember this").
 * @module tests/unit/agent/privacy
 */

import { describe, it, expect } from "bun:test";
import { createPrivacyManager } from "../../../src/agent/privacy.js";
import { mockAuditLog } from "../../helpers/index.js";

describe("Privacy Manager", () => {
  it("should start with privacy mode disabled", () => {
    const manager = createPrivacyManager({ auditLog: mockAuditLog() });
    expect(manager.isPrivate("session-1")).toBe(false);
  });

  it("should enable privacy mode for a session", () => {
    const manager = createPrivacyManager({ auditLog: mockAuditLog() });
    manager.enable("session-1");
    expect(manager.isPrivate("session-1")).toBe(true);
  });

  it("should disable privacy mode for a session", () => {
    const manager = createPrivacyManager({ auditLog: mockAuditLog() });
    manager.enable("session-1");
    manager.disable("session-1");
    expect(manager.isPrivate("session-1")).toBe(false);
  });

  it("should track privacy mode per session", () => {
    const manager = createPrivacyManager({ auditLog: mockAuditLog() });
    manager.enable("session-1");

    expect(manager.isPrivate("session-1")).toBe(true);
    expect(manager.isPrivate("session-2")).toBe(false);
  });

  it("should detect /private command", () => {
    const manager = createPrivacyManager({ auditLog: mockAuditLog() });
    expect(manager.isPrivateCommand("/private")).toBe(true);
    expect(manager.isPrivateCommand("/private on")).toBe(true);
    expect(manager.isPrivateCommand("/private off")).toBe(true);
    expect(manager.isPrivateCommand("hello")).toBe(false);
  });

  it("should log privacy mode activation to audit log", () => {
    const auditLog = mockAuditLog();
    const manager = createPrivacyManager({ auditLog });
    manager.enable("session-1");

    const events = auditLog.entries.filter((e) => e.type === "PRIVACY_MODE");
    expect(events).toHaveLength(1);
  });
});
