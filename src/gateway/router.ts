/**
 * @fileoverview HTTP route registration for the gateway. Maps URL patterns
 * to handler functions with method-based routing.
 * @module gateway/router
 *
 * @note Provides a lightweight router that matches method + path combinations.
 * Supports path parameters via :param syntax.
 */

import type { Logger } from "../core/types.js";

/**
 * @brief Parsed HTTP request shape.
 */
export interface RouteRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  ip: string;
  params: Record<string, string>;
  query: Record<string, string>;
}

/**
 * @brief HTTP response builder.
 */
export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * @brief Route handler function type.
 */
export type RouteHandler = (req: RouteRequest) => Promise<RouteResponse>;

/**
 * @brief A registered route entry.
 */
interface RouteEntry {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

/**
 * @brief Router interface for the gateway.
 */
export interface Router {
  /**
   * @brief Registers a GET route.
   * @param pattern - URL pattern (e.g., "/api/chat", "/api/memory/:id")
   * @param handler - Route handler function
   */
  get(pattern: string, handler: RouteHandler): void;

  /**
   * @brief Registers a POST route.
   * @param pattern - URL pattern
   * @param handler - Route handler function
   */
  post(pattern: string, handler: RouteHandler): void;

  /**
   * @brief Registers a PUT route.
   * @param pattern - URL pattern
   * @param handler - Route handler function
   */
  put(pattern: string, handler: RouteHandler): void;

  /**
   * @brief Registers a DELETE route.
   * @param pattern - URL pattern
   * @param handler - Route handler function
   */
  delete(pattern: string, handler: RouteHandler): void;

  /**
   * @brief Matches a request to a registered route and executes the handler.
   * @param method - HTTP method
   * @param path - Request path
   * @param headers - Request headers
   * @param body - Request body
   * @param ip - Client IP address
   * @returns Promise resolving to RouteResponse, or null if no match
   */
  handle(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    ip: string
  ): Promise<RouteResponse | null>;

  /**
   * @brief Returns all registered route patterns.
   * @returns Array of "METHOD pattern" strings
   */
  list(): string[];
}

/**
 * @brief Dependencies for createRouter.
 */
export interface RouterDeps {
  logger: Logger;
}

/**
 * @brief Creates a lightweight HTTP router.
 * @param deps - Dependencies: logger
 * @returns Router instance
 *
 * @example
 * const router = createRouter({ logger });
 * router.post("/api/chat", async (req) => {
 *   const { message } = JSON.parse(req.body);
 *   return { status: 200, headers: {}, body: JSON.stringify({ reply: "Hello!" }) };
 * });
 */
export function createRouter(deps: RouterDeps): Router {
  const { logger } = deps;
  const routes: RouteEntry[] = [];

  /**
   * @brief Adds a route to the registry.
   * @param method - HTTP method (uppercase)
   * @param pattern - URL pattern
   * @param handler - Route handler
   */
  function addRoute(method: string, pattern: string, handler: RouteHandler): void {
    const segments = pattern.split("/").filter(Boolean);
    routes.push({ method: method.toUpperCase(), pattern, segments, handler });
    logger.debug("Route registered", { method: method.toUpperCase(), pattern });
  }

  /**
   * @brief Parses query string into key-value pairs.
   * @param queryString - Raw query string (without leading ?)
   * @returns Record of query parameters
   */
  function parseQuery(queryString: string): Record<string, string> {
    const params: Record<string, string> = {};
    if (!queryString) return params;
    for (const pair of queryString.split("&")) {
      const [key, value] = pair.split("=");
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(value ?? "");
      }
    }
    return params;
  }

  /**
   * @brief Matches a path against a route pattern, extracting params.
   * @param routeSegments - Pattern segments
   * @param pathSegments - Request path segments
   * @returns Extracted params or null if no match
   */
  function matchRoute(
    routeSegments: string[],
    pathSegments: string[]
  ): Record<string, string> | null {
    if (routeSegments.length !== pathSegments.length) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < routeSegments.length; i++) {
      const routeSeg = routeSegments[i]!;
      const pathSeg = pathSegments[i]!;

      if (routeSeg.startsWith(":")) {
        params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
      } else if (routeSeg !== pathSeg) {
        return null;
      }
    }

    return params;
  }

  return {
    get(pattern: string, handler: RouteHandler): void {
      addRoute("GET", pattern, handler);
    },

    post(pattern: string, handler: RouteHandler): void {
      addRoute("POST", pattern, handler);
    },

    put(pattern: string, handler: RouteHandler): void {
      addRoute("PUT", pattern, handler);
    },

    delete(pattern: string, handler: RouteHandler): void {
      addRoute("DELETE", pattern, handler);
    },

    async handle(
      method: string,
      path: string,
      headers: Record<string, string>,
      body: string,
      ip: string
    ): Promise<RouteResponse | null> {
      const upperMethod = method.toUpperCase();
      const [pathPart, queryString] = path.split("?");
      const pathSegments = (pathPart ?? "").split("/").filter(Boolean);
      const query = parseQuery(queryString ?? "");

      for (const route of routes) {
        if (route.method !== upperMethod) continue;

        const params = matchRoute(route.segments, pathSegments);
        if (params !== null) {
          logger.debug("Route matched", { method: upperMethod, pattern: route.pattern });

          const req: RouteRequest = {
            method: upperMethod,
            path: pathPart ?? "",
            headers,
            body,
            ip,
            params,
            query,
          };

          return route.handler(req);
        }
      }

      return null;
    },

    list(): string[] {
      return routes.map((r) => `${r.method} ${r.pattern}`);
    },
  };
}
