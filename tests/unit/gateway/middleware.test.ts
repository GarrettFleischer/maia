/**
 * @fileoverview Unit tests for gateway middleware chain (auth, rate-limit, WebSocket).
 * @module tests/unit/gateway/middleware
 */

import { describe, it, expect } from "bun:test";
import { createAuthMiddleware } from "../../../src/gateway/middleware/auth.js";
import { createRateLimitMiddleware } from "../../../src/gateway/middleware/rate-limit.js";
import { createTestContext } from "../../helpers/index.js";

describe("Auth Middleware", () => {
  it("should pass requests with valid token", async () => {
    const ctx = createTestContext();
    const middleware = createAuthMiddleware(ctx);

    const result = await middleware.handle({
      headers: { authorization: "Bearer test-token-12345" },
      ip: "127.0.0.1",
    });

    expect(result.authenticated).toBe(true);
  });

  it("should reject requests without auth header", async () => {
    const ctx = createTestContext();
    const middleware = createAuthMiddleware(ctx);

    const result = await middleware.handle({
      headers: {},
      ip: "127.0.0.1",
    });

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("should reject requests with invalid token", async () => {
    const ctx = createTestContext();
    const middleware = createAuthMiddleware(ctx);

    const result = await middleware.handle({
      headers: { authorization: "Bearer wrong-token" },
      ip: "127.0.0.1",
    });

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
  });
});

describe("Rate Limit Middleware", () => {
  it("should allow requests within limit", async () => {
    const ctx = createTestContext();
    const middleware = createRateLimitMiddleware(ctx);

    const result = await middleware.handle({ ip: "192.168.1.1" });
    expect(result.allowed).toBe(true);
  });

  it("should include rate limit headers", async () => {
    const ctx = createTestContext();
    const middleware = createRateLimitMiddleware(ctx);

    const result = await middleware.handle({ ip: "192.168.1.1" });
    expect(result.headers["X-RateLimit-Limit"]).toBeDefined();
    expect(result.headers["X-RateLimit-Remaining"]).toBeDefined();
  });

  it("should block requests exceeding limit", async () => {
    const ctx = createTestContext();
    // Config has maxRequests: 60 by default -- override
    ctx.config.security.rateLimiting.maxRequests = 2;
    const middleware = createRateLimitMiddleware(ctx);

    await middleware.handle({ ip: "1.2.3.4" });
    await middleware.handle({ ip: "1.2.3.4" });
    const result = await middleware.handle({ ip: "1.2.3.4" });

    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(429);
  });
});
