/**
 * @fileoverview Sliding-window rate limiter per IP. Tracks request timestamps,
 * removes expired entries on each check, and denies when count exceeds maxRequests.
 * @module security/rate-limiter
 */

import type { Clock } from "../core/types.js";

/**
 * @brief Options for creating a rate limiter.
 */
export interface RateLimiterOptions {
  /** Maximum requests allowed per window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Clock abstraction for time operations (injectable for tests). */
  clock: Clock;
}

/**
 * @brief Result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Maximum requests per window. */
  limit: number;
  /** Seconds until the oldest request in the window expires (0 if allowed). */
  retryAfter: number;
  /** Unix timestamp (ms) when the window resets. */
  resetAt: number;
}

/**
 * @brief Rate limiter instance returned by createRateLimiter.
 */
export interface RateLimiter {
  check(ip: string): RateLimitResult;
}

/**
 * @brief Creates a sliding-window rate limiter per IP.
 * @param options - maxRequests, windowMs, and clock
 * @returns Rate limiter with check(ip) method
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { maxRequests, windowMs, clock } = options;
  const timestampsByIp = new Map<string, number[]>();

  /**
   * @brief Checks if a request from the given IP is allowed under the rate limit.
   * @param ip - Client IP address
   * @returns { allowed, remaining, limit, retryAfter, resetAt }
   */
  function check(ip: string): RateLimitResult {
    const now = clock.now().getTime();
    const cutoff = now - windowMs;

    let timestamps = timestampsByIp.get(ip);
    if (!timestamps) {
      timestamps = [];
      timestampsByIp.set(ip, timestamps);
    }

    // Remove expired timestamps (sliding window)
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }

    const count = timestamps.length;
    const allowed = count < maxRequests;

    if (allowed) {
      timestamps.push(now);
    }

    const oldestInWindow = timestamps[0];
    const resetAt = oldestInWindow ? oldestInWindow + windowMs : now + windowMs;
    const retryAfter = allowed ? 0 : Math.ceil((resetAt - now) / 1000);

    return {
      allowed,
      remaining: allowed ? maxRequests - count - 1 : 0,
      limit: maxRequests,
      retryAfter,
      resetAt,
    };
  }

  return { check };
}
