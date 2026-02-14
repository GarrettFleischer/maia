/**
 * @fileoverview Unit tests for the gateway server middleware chain.
 * @module tests/unit/gateway/server
 */

import { describe, it, expect } from "bun:test";
import { createGatewayServer } from "../../../src/gateway/server.js";
import { createRouter } from "../../../src/gateway/router.js";
import { createAuthMiddleware } from "../../../src/gateway/middleware/auth.js";
import { createRateLimitMiddleware } from "../../../src/gateway/middleware/rate-limit.js";
import { createCorsMiddleware } from "../../../src/gateway/middleware/cors.js";
import { createErrorHandler } from "../../../src/gateway/middleware/error-handler.js";
import { createTestContext, capturingLogger } from "../../helpers/index.js";

describe("GatewayServer", () => {
  function setup() {
    const ctx = createTestContext();
    const logger = capturingLogger();
    const router = createRouter({ logger });
    const authMiddleware = createAuthMiddleware(ctx);
    const rateLimitMiddleware = createRateLimitMiddleware(ctx);
    const corsMiddleware = createCorsMiddleware({
      allowedOrigins: ctx.config.gateway.cors.origins,
      logger,
    });
    const errorHandler = createErrorHandler({ logger });

    const gateway = createGatewayServer({
      ctx: { ...ctx, logger },
      router,
      authMiddleware,
      rateLimitMiddleware,
      corsMiddleware,
      errorHandler,
    });

    return { gateway, router, ctx, logger };
  }

  // ── Public health endpoint ───────────────────────────────────────

  it("should allow /api/health without auth", async () => {
    const { gateway, router } = setup();
    router.get("/api/health", async () => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: '{"ok":true}',
    }));

    const res = await gateway.handleRequest("GET", "/api/health", {}, "", "127.0.0.1");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("should allow /health without auth", async () => {
    const { gateway, router } = setup();
    router.get("/health", async () => ({
      status: 200, headers: {}, body: '{"ok":true}',
    }));

    const res = await gateway.handleRequest("GET", "/health", {}, "", "127.0.0.1");
    expect(res.status).toBe(200);
  });

  // ── Authentication required for non-public paths ─────────────────

  it("should reject unauthenticated requests to protected routes", async () => {
    const { gateway, router } = setup();
    router.post("/api/chat", async () => ({
      status: 200, headers: {}, body: "ok",
    }));

    const res = await gateway.handleRequest("POST", "/api/chat", {}, "", "127.0.0.1");
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error).toBe("Unauthorized");
  });

  it("should allow authenticated requests to protected routes", async () => {
    const { gateway, router, ctx } = setup();
    router.post("/api/chat", async () => ({
      status: 200, headers: {}, body: '{"reply":"hello"}',
    }));

    const res = await gateway.handleRequest(
      "POST",
      "/api/chat",
      { authorization: `Bearer ${ctx.config.gateway.auth.token}` },
      '{"message":"hi"}',
      "127.0.0.1"
    );
    expect(res.status).toBe(200);
  });

  // ── 404 for unmatched routes ─────────────────────────────────────

  it("should return 404 for unregistered routes", async () => {
    const { gateway, ctx } = setup();

    const res = await gateway.handleRequest(
      "GET",
      "/api/nonexistent",
      { authorization: `Bearer ${ctx.config.gateway.auth.token}` },
      "",
      "127.0.0.1"
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Not found");
  });

  // ── getRouter / getWSHandler ─────────────────────────────────────

  it("should return the router via getRouter()", () => {
    const { gateway, router } = setup();
    expect(gateway.getRouter()).toBe(router);
  });

  it("should return undefined for getWSHandler() when not configured", () => {
    const { gateway } = setup();
    expect(gateway.getWSHandler()).toBeUndefined();
  });

  // ── Error handling ───────────────────────────────────────────────

  it("should catch route handler errors and return 500", async () => {
    const { gateway, router, ctx } = setup();
    router.get("/api/boom", async () => {
      throw new Error("Something broke");
    });

    const res = await gateway.handleRequest(
      "GET",
      "/api/boom",
      { authorization: `Bearer ${ctx.config.gateway.auth.token}` },
      "",
      "127.0.0.1"
    );
    expect(res.status).toBe(500);
  });
});
