/**
 * @fileoverview Unit tests for sliding window rate limiter.
 * @module tests/unit/security/rate-limiter
 */

import { describe, it, expect } from "bun:test";
import { createRateLimiter } from "../../../src/security/rate-limiter.js";
import { fixedClock } from "../../helpers/index.js";

describe("RateLimiter", () => {
  it("should allow requests within the limit", () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({
      maxRequests: 5,
      windowMs: 60000,
      clock,
    });

    for (let i = 0; i < 5; i++) {
      const result = limiter.check("192.168.1.1");
      expect(result.allowed).toBe(true);
    }
  });

  it("should reject requests exceeding the limit", () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({
      maxRequests: 3,
      windowMs: 60000,
      clock,
    });

    limiter.check("192.168.1.1");
    limiter.check("192.168.1.1");
    limiter.check("192.168.1.1");

    const result = limiter.check("192.168.1.1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("should track limits per IP", () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({
      maxRequests: 2,
      windowMs: 60000,
      clock,
    });

    limiter.check("192.168.1.1");
    limiter.check("192.168.1.1");

    // Different IP should still be allowed
    const result = limiter.check("192.168.1.2");
    expect(result.allowed).toBe(true);
  });

  it("should return remaining count", () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({
      maxRequests: 5,
      windowMs: 60000,
      clock,
    });

    const result1 = limiter.check("192.168.1.1");
    expect(result1.remaining).toBe(4);

    const result2 = limiter.check("192.168.1.1");
    expect(result2.remaining).toBe(3);
  });

  it("should reset after window expires", () => {
    let currentTime = new Date("2026-02-13T12:00:00.000Z");
    const clock = {
      now: () => currentTime,
      todayString: () => currentTime.toISOString().slice(0, 10),
      timestamp: () => currentTime.toISOString(),
    };

    const limiter = createRateLimiter({
      maxRequests: 2,
      windowMs: 60000,
      clock,
    });

    limiter.check("192.168.1.1");
    limiter.check("192.168.1.1");
    expect(limiter.check("192.168.1.1").allowed).toBe(false);

    // Advance time past window
    currentTime = new Date("2026-02-13T12:01:01.000Z");
    expect(limiter.check("192.168.1.1").allowed).toBe(true);
  });

  it("should include rate limit headers in result", () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({
      maxRequests: 10,
      windowMs: 60000,
      clock,
    });

    const result = limiter.check("192.168.1.1");
    expect(result.limit).toBe(10);
    expect(result.remaining).toBe(9);
    expect(result.resetAt).toBeDefined();
  });
});
