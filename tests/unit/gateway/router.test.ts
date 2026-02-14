/**
 * @fileoverview Unit tests for the gateway HTTP router.
 * @module tests/unit/gateway/router
 */

import { describe, it, expect } from "bun:test";
import { createRouter } from "../../../src/gateway/router.js";
import { capturingLogger } from "../../helpers/index.js";

describe("Router", () => {
  function setup() {
    const logger = capturingLogger();
    const router = createRouter({ logger });
    return { router, logger };
  }

  // ── Route registration and matching ──────────────────────────────

  it("should match a GET route", async () => {
    const { router } = setup();
    router.get("/api/health", async () => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: '{"ok":true}',
    }));

    const result = await router.handle("GET", "/api/health", {}, "", "127.0.0.1");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.body).toBe('{"ok":true}');
  });

  it("should match a POST route", async () => {
    const { router } = setup();
    router.post("/api/chat", async (req) => ({
      status: 200,
      headers: {},
      body: `echo: ${req.body}`,
    }));

    const result = await router.handle("POST", "/api/chat", {}, "hello", "127.0.0.1");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("echo: hello");
  });

  it("should return null for unmatched routes", async () => {
    const { router } = setup();
    router.get("/api/health", async () => ({
      status: 200, headers: {}, body: "ok",
    }));

    const result = await router.handle("GET", "/api/nonexistent", {}, "", "127.0.0.1");
    expect(result).toBeNull();
  });

  it("should not match wrong HTTP method", async () => {
    const { router } = setup();
    router.get("/api/data", async () => ({
      status: 200, headers: {}, body: "ok",
    }));

    const result = await router.handle("POST", "/api/data", {}, "", "127.0.0.1");
    expect(result).toBeNull();
  });

  // ── Path parameters ──────────────────────────────────────────────

  it("should extract path parameters", async () => {
    const { router } = setup();
    router.get("/api/memory/:id", async (req) => ({
      status: 200,
      headers: {},
      body: `id=${req.params.id}`,
    }));

    const result = await router.handle("GET", "/api/memory/abc-123", {}, "", "127.0.0.1");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("id=abc-123");
  });

  it("should extract multiple path parameters", async () => {
    const { router } = setup();
    router.get("/api/:resource/:id", async (req) => ({
      status: 200,
      headers: {},
      body: `${req.params.resource}:${req.params.id}`,
    }));

    const result = await router.handle("GET", "/api/users/42", {}, "", "127.0.0.1");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("users:42");
  });

  // ── Query parameters ─────────────────────────────────────────────

  it("should parse query parameters", async () => {
    const { router } = setup();
    router.get("/api/search", async (req) => ({
      status: 200,
      headers: {},
      body: `q=${req.query.q}`,
    }));

    const result = await router.handle("GET", "/api/search?q=hello+world", {}, "", "127.0.0.1");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("q=hello+world");
  });

  // ── Route listing ────────────────────────────────────────────────

  it("should list all registered routes", () => {
    const { router } = setup();
    router.get("/api/health", async () => ({ status: 200, headers: {}, body: "" }));
    router.post("/api/chat", async () => ({ status: 200, headers: {}, body: "" }));
    router.put("/api/config", async () => ({ status: 200, headers: {}, body: "" }));
    router.delete("/api/memory/:id", async () => ({ status: 200, headers: {}, body: "" }));

    const routes = router.list();
    expect(routes).toContain("GET /api/health");
    expect(routes).toContain("POST /api/chat");
    expect(routes).toContain("PUT /api/config");
    expect(routes).toContain("DELETE /api/memory/:id");
  });

  // ── Request metadata ─────────────────────────────────────────────

  it("should pass headers, body, and IP to handler", async () => {
    const { router } = setup();
    router.post("/api/test", async (req) => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        ip: req.ip,
        auth: req.headers["authorization"],
        method: req.method,
      }),
    }));

    const result = await router.handle(
      "POST",
      "/api/test",
      { authorization: "Bearer token123" },
      "body-data",
      "10.0.0.1"
    );

    const parsed = JSON.parse(result!.body);
    expect(parsed.ip).toBe("10.0.0.1");
    expect(parsed.auth).toBe("Bearer token123");
    expect(parsed.method).toBe("POST");
  });
});
