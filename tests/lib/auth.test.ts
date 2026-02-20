/**
 * @fileoverview Integration tests for API key auth validation.
 * @module tests/lib/auth.test
 */

import { describe, expect, it } from "bun:test";
import { requireApiKey } from "@/lib/auth";

describe("requireApiKey", () => {
  const validToken = "secret-key-123";

  it("returns 401 when Authorization header is missing", () => {
    const request = new Request("http://localhost/api/agents", {
      headers: {},
    });
    const result = requireApiKey(request, validToken);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.status).toBe(401);
    }
  });

  it("returns 401 when Authorization header is not Bearer", () => {
    const request = new Request("http://localhost/api/agents", {
      headers: { Authorization: "Basic foo" },
    });
    const result = requireApiKey(request, validToken);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.status).toBe(401);
    }
  });

  it("returns 401 when Bearer token is wrong", () => {
    const request = new Request("http://localhost/api/agents", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    const result = requireApiKey(request, validToken);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.status).toBe(401);
    }
  });

  it("returns null when Bearer token matches", () => {
    const request = new Request("http://localhost/api/agents", {
      headers: { Authorization: "Bearer secret-key-123" },
    });
    const result = requireApiKey(request, validToken);
    expect(result).toBeNull();
  });

  it("returns null when configured token is empty and request has no header (allow no auth in dev)", () => {
    const request = new Request("http://localhost/api/agents", { headers: {} });
    const result = requireApiKey(request, "");
    expect(result).toBeNull();
  });
});
