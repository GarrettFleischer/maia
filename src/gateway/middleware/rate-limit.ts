/**
 * @fileoverview Gateway rate limit middleware. Sliding-window rate limiter per IP.
 * @module gateway/middleware/rate-limit
 */

import type { MaiaContext } from "../../core/types.js";

/** @brief Request shape passed to rate limit middleware handle. */
export interface RateLimitRequest {
  ip: string;
}

/** @brief Result of rate limit check. */
export interface RateLimitResult {
  allowed: boolean;
  statusCode?: number;
  headers: Record<string, string>;
}

/** @brief Rate limit middleware interface. */
export interface RateLimitMiddleware {
  handle(req: RateLimitRequest): Promise<RateLimitResult>;
}

/**
 * @brief Creates rate limit middleware with sliding window per IP.
 * @param ctx - Maia context with config and clock
 * @returns RateLimitMiddleware with handle method
 */
export function createRateLimitMiddleware(ctx: MaiaContext): RateLimitMiddleware {
  const timestamps = new Map<string, number[]>();
  const { maxRequests, windowMs } = ctx.config.security.rateLimiting;

  return {
    /**
     * @brief Checks if request is within rate limit and returns headers.
     * @param req - Request with ip
     * @returns Promise resolving to RateLimitResult with X-RateLimit-* headers
     */
    async handle(req: RateLimitRequest): Promise<RateLimitResult> {
      const now = ctx.clock.now().getTime();
      const cutoff = now - windowMs;

      let list = timestamps.get(req.ip) ?? [];
      list = list.filter((t) => t > cutoff);
      list.push(now);
      timestamps.set(req.ip, list);

      const count = list.length;
      const allowed = count <= maxRequests;
      const remaining = Math.max(0, maxRequests - count);
      const resetAt = list[0]! + windowMs;
      const resetSeconds = Math.ceil((resetAt - now) / 1000);

      const headers: Record<string, string> = {
        "X-RateLimit-Limit": String(maxRequests),
        "X-RateLimit-Remaining": String(remaining),
        "X-RateLimit-Reset": String(resetSeconds),
      };

      if (!allowed) {
        return {
          allowed: false,
          statusCode: 429,
          headers,
        };
      }

      return { allowed: true, headers };
    },
  };
}
