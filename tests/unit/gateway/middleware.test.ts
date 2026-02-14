/**
 * @fileoverview Unit tests for gateway middleware chain (auth, rate-limit, error-handler).
 * @module tests/unit/gateway/middleware
 */

import { describe, it, expect } from "bun:test";
import { createAuthMiddleware } from "../../../src/gateway/middleware/auth.js";
import { createRateLimitMiddleware } from "../../../src/gateway/middleware/rate-limit.js";
import { createCorsMiddleware } from "../../../src/gateway/middleware/cors.js";
import { createErrorHandler } from "../../../src/gateway/middleware/error-handler.js";
import { MaiaError, AuthError, RateLimitError, ValidationError } from "../../../src/core/errors.js";
import { createTestContext, capturingLogger } from "../../helpers/index.js";

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

  it("should reject requests with invalid format (no Bearer prefix)", async () => {
    const ctx = createTestContext();
    const middleware = createAuthMiddleware(ctx);

    const result = await middleware.handle({
      headers: { authorization: "Basic xxx" },
      ip: "127.0.0.1",
    });

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("should reject requests with Bearer but empty token", async () => {
    const ctx = createTestContext();
    const middleware = createAuthMiddleware(ctx);

    const result = await middleware.handle({
      headers: { authorization: "Bearer " },
      ip: "127.0.0.1",
    });

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
  });
});

describe("CORS Middleware", () => {
  it("should allow request when origin is in whitelist", () => {
    const logger = capturingLogger();
    const cors = createCorsMiddleware({
      allowedOrigins: ["https://app.example.com"],
      logger,
    });
    const result = cors.handle({
      method: "GET",
      headers: { origin: "https://app.example.com" },
    });
    expect(result.allowed).toBe(true);
    expect(result.headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
  });

  it("should reject request when origin is not in whitelist", () => {
    const logger = capturingLogger();
    const cors = createCorsMiddleware({
      allowedOrigins: ["https://app.example.com"],
      logger,
    });
    const result = cors.handle({
      method: "GET",
      headers: { origin: "https://evil.com" },
    });
    expect(result.allowed).toBe(false);
    expect(result.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("should allow any origin when wildcard is configured", () => {
    const logger = capturingLogger();
    const cors = createCorsMiddleware({
      allowedOrigins: ["*"],
      logger,
    });
    const result = cors.handle({
      method: "GET",
      headers: { origin: "https://any-origin.com" },
    });
    expect(result.allowed).toBe(true);
  });

  it("should set isPreflight for OPTIONS requests", () => {
    const logger = capturingLogger();
    const cors = createCorsMiddleware({
      allowedOrigins: ["https://app.example.com"],
      logger,
    });
    const result = cors.handle({
      method: "OPTIONS",
      headers: { origin: "https://app.example.com" },
    });
    expect(result.isPreflight).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it("should allow request when no origin header", () => {
    const logger = capturingLogger();
    const cors = createCorsMiddleware({
      allowedOrigins: ["https://app.example.com"],
      logger,
    });
    const result = cors.handle({ method: "GET", headers: {} });
    expect(result.allowed).toBe(true);
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

describe("Error Handler Middleware", () => {
  it("should handle RateLimitError with Retry-After header", () => {
    const logger = capturingLogger();
    const handler = createErrorHandler({ logger });
    const err = new RateLimitError(42);
    const res = handler.handle(err);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("42");
    expect(res.error.code).toBe("RATE_LIMITED");
  });

  it("should handle AuthError with 401", () => {
    const logger = capturingLogger();
    const handler = createErrorHandler({ logger });
    const err = new AuthError("invalid token");
    const res = handler.handle(err);
    expect(res.statusCode).toBe(401);
    expect(res.error.code).toBe("AUTH_ERROR");
  });

  it("should handle ValidationError with 400", () => {
    const logger = capturingLogger();
    const handler = createErrorHandler({ logger });
    const err = new ValidationError("message", "too long");
    const res = handler.handle(err);
    expect(res.statusCode).toBe(400);
    expect(res.error.code).toBe("VALIDATION_ERROR");
  });

  it("should handle generic MaiaError with 500", () => {
    const logger = capturingLogger();
    const handler = createErrorHandler({ logger });
    const err = new MaiaError("CUSTOM", "something failed");
    const res = handler.handle(err);
    expect(res.statusCode).toBe(500);
    expect(res.error.code).toBe("CUSTOM");
  });

  it("should handle unknown Error as INTERNAL_ERROR", () => {
    const logger = capturingLogger();
    const handler = createErrorHandler({ logger });
    const res = handler.handle(new Error("unexpected"));
    expect(res.statusCode).toBe(500);
    expect(res.error.code).toBe("INTERNAL_ERROR");
    expect(res.error.message).toBe("unexpected");
  });

  it("should handle non-Error throwables", () => {
    const logger = capturingLogger();
    const handler = createErrorHandler({ logger });
    const res = handler.handle("string throw");
    expect(res.statusCode).toBe(500);
    expect(res.error.code).toBe("INTERNAL_ERROR");
    expect(res.error.message).toContain("unexpected");
  });

  it("should include stack when includeStack is true", () => {
    const logger = capturingLogger();
    const handler = createErrorHandler({ logger, includeStack: true });
    const err = new AuthError("bad");
    const res = handler.handle(err);
    expect(res.error.stack).toBeDefined();
    expect(typeof res.error.stack).toBe("string");
  });
});
