/**
 * @fileoverview Unit tests for SSRF protection (private IP blocking + DNS pinning).
 * @module tests/unit/security/ssrf-guard
 */

import { describe, it, expect } from "bun:test";
import { createSsrfGuard } from "../../../src/security/ssrf-guard.js";

describe("SSRF Guard", () => {
  it("should allow public URLs", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("https://api.example.com/data")).toBe(true);
  });

  it("should block localhost", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("http://localhost/admin")).toBe(false);
    expect(guard.isAllowed("http://127.0.0.1/admin")).toBe(false);
  });

  it("should block private IP ranges (10.x.x.x)", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("http://10.0.0.1/internal")).toBe(false);
    expect(guard.isAllowed("http://10.255.255.255/internal")).toBe(false);
  });

  it("should block private IP ranges (172.16-31.x.x)", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("http://172.16.0.1/internal")).toBe(false);
    expect(guard.isAllowed("http://172.31.255.255/internal")).toBe(false);
  });

  it("should allow non-private 172.x range", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("http://172.15.0.1/external")).toBe(true);
    expect(guard.isAllowed("http://172.32.0.1/external")).toBe(true);
  });

  it("should block private IP ranges (192.168.x.x)", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("http://192.168.1.1/internal")).toBe(false);
  });

  it("should block link-local (169.254.x.x)", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("http://169.254.169.254/metadata")).toBe(false);
  });

  it("should block IPv6 loopback", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("http://[::1]/admin")).toBe(false);
  });

  it("should only allow http and https protocols", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("ftp://example.com/file")).toBe(false);
    expect(guard.isAllowed("file:///etc/passwd")).toBe(false);
    expect(guard.isAllowed("javascript:alert(1)")).toBe(false);
  });

  it("should handle malformed URLs gracefully", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("not-a-url")).toBe(false);
    expect(guard.isAllowed("")).toBe(false);
  });

  it("should allow everything when blockPrivateIPs is false", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: false });
    expect(guard.isAllowed("http://localhost/admin")).toBe(true);
    expect(guard.isAllowed("http://10.0.0.1/internal")).toBe(true);
  });

  it("should block 0.0.0.0", () => {
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    expect(guard.isAllowed("http://0.0.0.0/internal")).toBe(false);
  });
});
