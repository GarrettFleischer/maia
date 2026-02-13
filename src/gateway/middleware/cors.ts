/**
 * @fileoverview CORS middleware for the gateway. Validates Origin headers
 * against the configured whitelist and sets appropriate response headers.
 * @module gateway/middleware/cors
 *
 * @note Supports wildcard ("*") and exact-match origins. Handles preflight
 * OPTIONS requests by returning early with 204 status.
 */

import type { Logger } from "../../core/types.js";

/**
 * @brief Dependencies for createCorsMiddleware.
 */
export interface CorsMiddlewareDeps {
  allowedOrigins: string[];
  logger: Logger;
}

/**
 * @brief CORS request shape.
 */
export interface CorsRequest {
  method: string;
  headers: Record<string, string>;
}

/**
 * @brief CORS validation result.
 */
export interface CorsResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Response headers to set */
  headers: Record<string, string>;
  /** If true, this is a preflight request and should be responded to immediately */
  isPreflight: boolean;
}

/**
 * @brief CORS middleware interface.
 */
export interface CorsMiddleware {
  /**
   * @brief Validates the request origin and returns CORS headers.
   * @param req - Request with method and headers
   * @returns CorsResult with allowed status, headers, and preflight flag
   */
  handle(req: CorsRequest): CorsResult;
}

/**
 * @brief Creates a CORS middleware instance.
 * @param deps - Dependencies: allowedOrigins, logger
 * @returns CorsMiddleware instance
 *
 * @example
 * const cors = createCorsMiddleware({ allowedOrigins: ["https://example.com"], logger });
 * const result = cors.handle({ method: "GET", headers: { origin: "https://example.com" } });
 * // result.allowed === true, result.headers["Access-Control-Allow-Origin"] === "https://example.com"
 */
export function createCorsMiddleware(deps: CorsMiddlewareDeps): CorsMiddleware {
  const { allowedOrigins, logger } = deps;

  /**
   * @brief Checks if an origin is in the allowed list.
   * @param origin - Origin header value
   * @returns true if origin is allowed
   */
  function isOriginAllowed(origin: string): boolean {
    if (allowedOrigins.includes("*")) return true;
    return allowedOrigins.includes(origin);
  }

  return {
    handle(req: CorsRequest): CorsResult {
      const origin =
        req.headers["origin"] ??
        req.headers["Origin"] ??
        Object.entries(req.headers).find(
          ([k]) => k.toLowerCase() === "origin"
        )?.[1] ??
        "";

      const headers: Record<string, string> = {};
      const isPreflight = req.method.toUpperCase() === "OPTIONS";

      if (!origin) {
        // No origin header: same-origin or non-browser request, allow
        return { allowed: true, headers, isPreflight };
      }

      if (!isOriginAllowed(origin)) {
        logger.warn("CORS origin rejected", { origin });
        return { allowed: false, headers, isPreflight };
      }

      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
      headers["Access-Control-Allow-Headers"] =
        "Content-Type, Authorization, X-Request-ID";
      headers["Access-Control-Max-Age"] = "86400";
      headers["Vary"] = "Origin";

      if (isPreflight) {
        logger.debug("CORS preflight handled", { origin });
      }

      return { allowed: true, headers, isPreflight };
    },
  };
}
