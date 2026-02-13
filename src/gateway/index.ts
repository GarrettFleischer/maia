/**
 * @fileoverview Gateway subsystem public exports.
 * @module gateway
 */

export { createAuthMiddleware } from "./middleware/auth.js";
export type { AuthMiddleware, AuthRequest, AuthResult } from "./middleware/auth.js";
export { createRateLimitMiddleware } from "./middleware/rate-limit.js";
export type { RateLimitMiddleware, RateLimitRequest, RateLimitResult } from "./middleware/rate-limit.js";
export { createCorsMiddleware } from "./middleware/cors.js";
export type { CorsMiddleware, CorsMiddlewareDeps, CorsRequest, CorsResult } from "./middleware/cors.js";
export { createErrorHandler } from "./middleware/error-handler.js";
export type { ErrorHandler, ErrorHandlerDeps, ErrorResponse } from "./middleware/error-handler.js";
export { createRouter } from "./router.js";
export type { Router, RouterDeps, RouteRequest, RouteResponse, RouteHandler } from "./router.js";
export { createWSHandler } from "./ws-handler.js";
export type { WSHandler, WSHandlerDeps, WSMessage, WSConnection } from "./ws-handler.js";
export { createGatewayServer } from "./server.js";
export type { GatewayServer, GatewayServerDeps } from "./server.js";
