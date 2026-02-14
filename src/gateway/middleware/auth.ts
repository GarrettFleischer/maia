/**
 * @fileoverview Gateway authentication middleware. Validates Bearer token against
 * configured gateway auth token using timing-safe comparison.
 * @module gateway/middleware/auth
 */

import type { MaiaContext } from "../../core/types.js";

/** @brief Request shape passed to auth middleware handle. */
export interface AuthRequest {
  headers: Record<string, string>;
  ip: string;
}

/** @brief Result of auth middleware validation. */
export interface AuthResult {
  authenticated: boolean;
  statusCode?: number;
}

/** @brief Auth middleware interface. */
export interface AuthMiddleware {
  handle(req: AuthRequest): Promise<AuthResult>;
}

/**
 * @brief Creates auth middleware that validates Bearer token.
 * @param ctx - Maia context with config, crypto, and auditLog
 * @returns AuthMiddleware with handle method
 */
export function createAuthMiddleware(ctx: MaiaContext): AuthMiddleware {
  const encoder = new TextEncoder();

  return {
    /**
     * @brief Validates authorization header and logs result to audit.
     * @param req - Request with headers and ip
     * @returns Promise resolving to AuthResult
     */
    async handle(req: AuthRequest): Promise<AuthResult> {
      const raw =
        req.headers["authorization"] ??
        req.headers["Authorization"] ??
        Object.entries(req.headers).find(
          ([k]) => k.toLowerCase() === "authorization",
        )?.[1];

      if (!raw) {
        await ctx.auditLog.log("AUTH_FAILURE", {
          ip: req.ip,
          reason: "missing_header",
        });
        return { authenticated: false, statusCode: 401 };
      }

      if (!raw.startsWith("Bearer ") || raw.length <= 7) {
        await ctx.auditLog.log("AUTH_FAILURE", {
          ip: req.ip,
          reason: "invalid_format",
        });
        return { authenticated: false, statusCode: 401 };
      }

      const token = raw.slice(7).trim();
      const expected = (ctx.config.gateway.auth.token ?? "").trim();
      const a = encoder.encode(token);
      const b = encoder.encode(expected);

      if (a.length !== b.length || !ctx.crypto.timingSafeEqual(a, b)) {
        await ctx.auditLog.log("AUTH_FAILURE", {
          ip: req.ip,
          reason: "invalid_token",
        });
        return { authenticated: false, statusCode: 401 };
      }

      await ctx.auditLog.log("AUTH_SUCCESS", { ip: req.ip });
      return { authenticated: true };
    },
  };
}
