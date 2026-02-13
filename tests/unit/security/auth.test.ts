/**
 * @fileoverview Unit tests for token authentication with timing-safe comparison.
 * @module tests/unit/security/auth
 */

import { describe, it, expect } from "bun:test";
import { createAuth } from "../../../src/security/auth.js";
import { createTestContext, mockCryptoProvider, mockAuditLog } from "../../helpers/index.js";

describe("Auth", () => {
  it("should accept a valid token", async () => {
    const ctx = createTestContext();
    const auth = createAuth(ctx);

    const result = await auth.verify("test-token-12345");
    expect(result.valid).toBe(true);
  });

  it("should reject an invalid token", async () => {
    const ctx = createTestContext();
    const auth = createAuth(ctx);

    const result = await auth.verify("wrong-token");
    expect(result.valid).toBe(false);
  });

  it("should reject an empty token", async () => {
    const ctx = createTestContext();
    const auth = createAuth(ctx);

    const result = await auth.verify("");
    expect(result.valid).toBe(false);
  });

  it("should use timing-safe comparison", async () => {
    const crypto = mockCryptoProvider();
    let timingSafeCalled = false;
    const originalTimingSafeEqual = crypto.timingSafeEqual;
    crypto.timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
      timingSafeCalled = true;
      return originalTimingSafeEqual(a, b);
    };

    const ctx = createTestContext({ crypto });
    const auth = createAuth(ctx);

    await auth.verify("some-token");
    expect(timingSafeCalled).toBe(true);
  });

  it("should log auth failures to audit log", async () => {
    const auditLog = mockAuditLog();
    const ctx = createTestContext({ auditLog });
    const auth = createAuth(ctx);

    await auth.verify("wrong-token", { ip: "192.168.1.100" });

    const failures = auditLog.entries.filter((e) => e.type === "AUTH_FAILURE");
    expect(failures).toHaveLength(1);
    expect(failures[0].metadata.ip).toBe("192.168.1.100");
  });

  it("should log auth successes to audit log", async () => {
    const auditLog = mockAuditLog();
    const ctx = createTestContext({ auditLog });
    const auth = createAuth(ctx);

    await auth.verify("test-token-12345", { ip: "192.168.1.100" });

    const successes = auditLog.entries.filter((e) => e.type === "AUTH_SUCCESS");
    expect(successes).toHaveLength(1);
  });

  it("should extract token from Bearer header", async () => {
    const ctx = createTestContext();
    const auth = createAuth(ctx);

    const result = await auth.verifyHeader("Bearer test-token-12345");
    expect(result.valid).toBe(true);
  });

  it("should reject malformed Bearer header", async () => {
    const ctx = createTestContext();
    const auth = createAuth(ctx);

    const result = await auth.verifyHeader("Basic abc123");
    expect(result.valid).toBe(false);
  });
});
