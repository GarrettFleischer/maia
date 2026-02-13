/**
 * @fileoverview Unit tests for secret scanner (detects leaked credentials in memory writes).
 * @module tests/unit/security/secret-scanner
 */

import { describe, it, expect } from "bun:test";
import { createSecretScanner } from "../../../src/security/secret-scanner.js";
import { mockAuditLog } from "../../helpers/index.js";

describe("Secret Scanner", () => {
  it("should detect OpenAI-style API keys", () => {
    const scanner = createSecretScanner({ patterns: [], auditLog: mockAuditLog() });
    const result = scanner.scan("My key is sk-proj-abc123def456ghi789");
    expect(result.hasSecrets).toBe(true);
    expect(result.detections.length).toBeGreaterThan(0);
  });

  it("should detect GitHub tokens", () => {
    const scanner = createSecretScanner({ patterns: [], auditLog: mockAuditLog() });
    const result = scanner.scan("Token: ghp_1234567890abcdefghijklmnopqrstuvwx");
    expect(result.hasSecrets).toBe(true);
  });

  it("should detect Bearer tokens", () => {
    const scanner = createSecretScanner({ patterns: [], auditLog: mockAuditLog() });
    const result = scanner.scan("Header: Bearer eyJhbGciOiJIUzI1NiJ9.test.sig");
    expect(result.hasSecrets).toBe(true);
  });

  it("should detect PEM private keys", () => {
    const scanner = createSecretScanner({ patterns: [], auditLog: mockAuditLog() });
    const result = scanner.scan("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----");
    expect(result.hasSecrets).toBe(true);
  });

  it("should not flag normal text", () => {
    const scanner = createSecretScanner({ patterns: [], auditLog: mockAuditLog() });
    const result = scanner.scan("The user prefers dark mode and likes TypeScript.");
    expect(result.hasSecrets).toBe(false);
  });

  it("should redact detected secrets", () => {
    const scanner = createSecretScanner({ patterns: [], auditLog: mockAuditLog() });
    const result = scanner.scan("My key is sk-proj-abc123def456ghi789");
    expect(result.redacted).not.toContain("sk-proj-abc123def456ghi789");
    expect(result.redacted).toContain("[REDACTED]");
  });

  it("should support custom patterns", () => {
    const scanner = createSecretScanner({
      patterns: ["CUSTOM_SECRET_\\w+"],
      auditLog: mockAuditLog(),
    });
    const result = scanner.scan("Found: CUSTOM_SECRET_xyz123");
    expect(result.hasSecrets).toBe(true);
  });

  it("should log detections to audit log", () => {
    const auditLog = mockAuditLog();
    const scanner = createSecretScanner({ patterns: [], auditLog });
    scanner.scan("My key is sk-proj-abc123def456ghi789");

    const events = auditLog.entries.filter((e) => e.type === "SECRET_DETECTED");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("should detect Slack tokens", () => {
    const scanner = createSecretScanner({ patterns: [], auditLog: mockAuditLog() });
    const result = scanner.scan("Token: xoxb-1234-5678-abcdefghijklmnop");
    expect(result.hasSecrets).toBe(true);
  });

  it("should handle empty input", () => {
    const scanner = createSecretScanner({ patterns: [], auditLog: mockAuditLog() });
    const result = scanner.scan("");
    expect(result.hasSecrets).toBe(false);
  });
});
