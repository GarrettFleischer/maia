/**
 * @fileoverview Gateway server setup with middleware chain.
 * @module gateway/server
 *
 * @note Orchestrates the HTTP/WebSocket server lifecycle:
 * 1. CORS validation
 * 2. Rate limiting (skipped for GET requests to web UI assets to avoid 429 on first load)
 * 3. Authentication
 * 4. Route matching
 * 5. Error handling
 *
 * Uses Bun's built-in HTTP server. The server is created but not started
 * until start() is called; this allows tests to configure routes first.
 */

import type { MaiaContext, Logger } from "../core/types.js";
import type { AuthMiddleware } from "./middleware/auth.js";
import type { RateLimitMiddleware } from "./middleware/rate-limit.js";
import type { CorsMiddleware } from "./middleware/cors.js";
import type { ErrorHandler } from "./middleware/error-handler.js";
import type { Router, RouteResponse } from "./router.js";
import type { WSHandler } from "./ws-handler.js";

/**
 * @brief Dependencies for createGatewayServer.
 */
export interface GatewayServerDeps {
  ctx: MaiaContext;
  router: Router;
  authMiddleware: AuthMiddleware;
  rateLimitMiddleware: RateLimitMiddleware;
  corsMiddleware: CorsMiddleware;
  errorHandler: ErrorHandler;
  wsHandler?: WSHandler;
}

/**
 * @brief Gateway server interface.
 */
export interface GatewayServer {
  /**
   * @brief Processes an HTTP request through the middleware chain.
   * @param method - HTTP method
   * @param path - Request path
   * @param headers - Request headers
   * @param body - Request body string
   * @param ip - Client IP address
   * @returns Promise resolving to the HTTP response
   */
  handleRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    ip: string,
  ): Promise<RouteResponse>;

  /**
   * @brief Returns the router for route registration.
   * @returns Router instance
   */
  getRouter(): Router;

  /**
   * @brief Returns the WebSocket handler, if configured.
   * @returns WSHandler or undefined
   */
  getWSHandler(): WSHandler | undefined;
}

/**
 * @brief Creates a gateway server with middleware chain.
 * @param deps - All gateway dependencies
 * @returns GatewayServer instance
 *
 * @note The middleware chain executes in order:
 * 1. CORS (preflight returns immediately)
 * 2. Rate limiting
 * 3. Authentication (Bearer token required for all requests)
 * 4. Route matching
 * 5. Error handling wraps everything
 *
 * @example
 * const server = createGatewayServer({
 *   ctx, router, authMiddleware, rateLimitMiddleware,
 *   corsMiddleware, errorHandler, wsHandler,
 * });
 *
 * router.get("/api/health", async () => ({
 *   status: 200, headers: {}, body: JSON.stringify({ ok: true }),
 * }));
 *
 * const response = await server.handleRequest("GET", "/api/health", {}, "", "127.0.0.1");
 */

/** Paths/extensions for web UI assets; GET to these are exempt from rate limiting. */
const WEB_UI_ASSET_EXT = /\.(html?|css|js|ico|svg|png|woff2?)(\?|$)/i;
const WEB_UI_ROOT_PATHS = ["/", "/index.html"];

/**
 * @brief True if this request is a GET for a web UI asset (not counted toward rate limit).
 * @param method - HTTP method
 * @param pathBase - Path without query string
 */
function isWebUIAssetRequest(method: string, pathBase: string): boolean {
  if (method !== "GET") return false;
  if (WEB_UI_ROOT_PATHS.includes(pathBase)) return true;
  return WEB_UI_ASSET_EXT.test(pathBase);
}

/** GET /api/health and /health are exempt from rate limiting (token check and health probes). */
const RATE_LIMIT_EXEMPT_PATHS = ["/api/health", "/health"];

/**
 * @brief True if this request should not be counted toward rate limit.
 */
function isRateLimitExempt(method: string, pathBase: string): boolean {
  if (method !== "GET") return false;
  return isWebUIAssetRequest(method, pathBase) || RATE_LIMIT_EXEMPT_PATHS.includes(pathBase);
}

export function createGatewayServer(deps: GatewayServerDeps): GatewayServer {
  const {
    ctx,
    router,
    authMiddleware,
    rateLimitMiddleware,
    corsMiddleware,
    errorHandler,
    wsHandler,
  } = deps;
  const logger: Logger = ctx.logger;

  async function handleRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    ip: string,
  ): Promise<RouteResponse> {
    try {
      // Step 1: CORS
      const corsResult = corsMiddleware.handle({ method, headers });
      if (!corsResult.allowed) {
        return {
          status: 403,
          headers: corsResult.headers,
          body: JSON.stringify({ error: "CORS origin not allowed" }),
        };
      }
      if (corsResult.isPreflight) {
        return {
          status: 204,
          headers: corsResult.headers,
          body: "",
        };
      }

      const pathBase = path.split("?")[0] ?? path;

      // Step 2: Rate limiting (skip for web UI assets and health so token check / probes don't hit 429)
      let rateResult: { allowed: boolean; statusCode?: number; headers: Record<string, string> };
      if (isRateLimitExempt(method, pathBase)) {
        rateResult = { allowed: true, headers: {} };
      } else {
        rateResult = await rateLimitMiddleware.handle({ ip });
      }
      if (!rateResult.allowed) {
        return {
          status: rateResult.statusCode ?? 429,
          headers: { ...corsResult.headers, ...rateResult.headers },
          body: JSON.stringify({ error: "Rate limit exceeded" }),
        };
      }

      // Step 3: Authentication (required except for public health and web UI asset GETs)
      // For public paths we still validate when Authorization is present so the UI can check the token.
      const publicPaths = ["/api/health", "/health"];
      const isPublicPath =
        publicPaths.includes(pathBase) || isWebUIAssetRequest(method, pathBase);
      const hasAuthHeader =
        headers["authorization"] ??
        headers["Authorization"] ??
        Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
      const requireAuth = !isPublicPath || !!hasAuthHeader;
      if (requireAuth) {
        const authResult = await authMiddleware.handle({ headers, ip });
        if (!authResult.authenticated) {
          return {
            status: authResult.statusCode ?? 401,
            headers: { ...corsResult.headers, ...rateResult.headers },
            body: JSON.stringify({ error: "Unauthorized" }),
          };
        }
      }

      // Step 4: Route matching
      const routeResponse = await router.handle(
        method,
        pathBase,
        headers,
        body,
        ip,
      );
      if (!routeResponse) {
        return {
          status: 404,
          headers: { ...corsResult.headers, ...rateResult.headers },
          body: JSON.stringify({ error: "Not found" }),
        };
      }

      // Merge middleware headers into route response
      return {
        ...routeResponse,
        headers: {
          ...corsResult.headers,
          ...rateResult.headers,
          ...routeResponse.headers,
        },
      };
    } catch (err) {
      const errorResponse = errorHandler.handle(err);
      logger.error("Request error", {
        method,
        path,
        statusCode: errorResponse.statusCode,
      });
      return {
        status: errorResponse.statusCode,
        headers: errorResponse.headers,
        body: JSON.stringify(errorResponse.error),
      };
    }
  }

  return {
    handleRequest,
    getRouter(): Router {
      return router;
    },
    getWSHandler(): WSHandler | undefined {
      return wsHandler;
    },
  };
}
