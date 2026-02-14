/**
 * @fileoverview Bridges Bun.serve to the GatewayServer middleware chain.
 * @module gateway/bun-server
 *
 * @note This module creates a real HTTP/WebSocket server using Bun's
 * native server API and delegates all request handling to the
 * existing GatewayServer which processes middleware chains.
 */

import type { Server, ServerWebSocket } from "bun";
import type { Logger, MaiaConfig } from "../core/types.js";
import type { GatewayServer } from "./server.js";

/**
 * @brief Options for starting the Bun HTTP server.
 */
export interface BunServerOptions {
  config: MaiaConfig;
  gateway: GatewayServer;
  logger: Logger;
}

/**
 * @brief WebSocket connection data attached to each upgraded connection.
 */
interface WSData {
  connectionId: string;
}

/**
 * @brief Running Bun server instance.
 */
export interface BunServer {
  /** The underlying Bun server */
  server: Server<WSData>;
  /** The URL the server is listening on */
  url: string;
  /** Stop the server */
  stop(): void;
}

/**
 * @brief Starts a Bun HTTP/WebSocket server bridged to the GatewayServer.
 * @param options - Server configuration, gateway instance, and logger
 * @returns BunServer with the running server, URL, and stop method
 *
 * @note The server:
 * - Delegates all HTTP requests to gatewayServer.handleRequest()
 * - Upgrades /ws connections to WebSocket and delegates to WSHandler
 * - Serves static web files from web/ for the webchat UI
 *
 * @example
 * const bunServer = startBunServer({ config, gateway, logger });
 * console.log(`Listening on ${bunServer.url}`);
 * // ... later ...
 * bunServer.stop();
 */
export function startBunServer(options: BunServerOptions): BunServer {
  const { config, gateway, logger } = options;
  const wsHandler = gateway.getWSHandler();

  // Track WebSocket connections by server-assigned ID
  const wsConnections = new Map<string, { ws: unknown; connectionId: string }>();
  let wsIdCounter = 0;

  const server = Bun.serve<WSData>({
    port: config.gateway.port,
    hostname: config.gateway.host,

    /**
     * @brief Main HTTP request handler.
     * @param req - Incoming HTTP request
     * @param server - Bun server instance (for WebSocket upgrades)
     * @returns Response object
     */
    async fetch(req: Request, server: Server<WSData>): Promise<Response> {
      const url = new URL(req.url);
      const pathName = url.pathname;

      // WebSocket upgrade
      if (pathName === "/ws" && wsHandler) {
        const connectionId = `ws-${++wsIdCounter}`;
        const upgraded = server.upgrade(req, {
          data: { connectionId },
        });
        if (upgraded) {
          return undefined as unknown as Response;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Regular HTTP: delegate to GatewayServer
      const method = req.method;
      const reqPath = pathName + url.search;
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = req.method !== "GET" && req.method !== "HEAD"
        ? await req.text()
        : "";

      // Extract client IP
      const ip = headers["x-forwarded-for"]?.split(",")[0]?.trim()
        ?? headers["x-real-ip"]
        ?? "unknown";

      const response = await gateway.handleRequest(method, reqPath, headers, body, ip);

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },

    /**
     * @brief WebSocket message handlers.
     */
    websocket: {
      open(ws: ServerWebSocket<WSData>) {
        if (!wsHandler) return;
        const { connectionId } = ws.data;
        wsConnections.set(connectionId, { ws, connectionId });
        wsHandler.connect(connectionId, connectionId);
        logger.debug("WebSocket connected", { connectionId });
      },

      async message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
        if (!wsHandler) return;
        const { connectionId } = ws.data;
        const raw = typeof message === "string" ? message : message.toString();

        const response = await wsHandler.handleMessage(connectionId, raw);
        if (response) {
          ws.send(response);
        }
      },

      close(ws: ServerWebSocket<WSData>) {
        if (!wsHandler) return;
        const { connectionId } = ws.data;
        wsHandler.disconnect(connectionId);
        wsConnections.delete(connectionId);
        logger.debug("WebSocket disconnected", { connectionId });
      },
    },
  });

  const serverUrl = `http://${config.gateway.host === "0.0.0.0" ? "localhost" : config.gateway.host}:${server.port}`;
  logger.info("Bun server started", { url: serverUrl, port: server.port });

  return {
    server,
    url: serverUrl,
    stop() {
      server.stop(true);
      logger.info("Bun server stopped");
    },
  };
}

/**
 * @brief Registers standard API routes on the gateway router.
 * @param gateway - GatewayServer to register routes on
 * @param deps - Dependencies for route handlers
 *
 * @note Routes:
 * - GET /api/health - Health check endpoint (public, no auth)
 * - POST /api/chat - Send a chat message through the agent
 * - GET /api/providers/health - Provider health status
 */
export function registerApiRoutes(
  gateway: GatewayServer,
  deps: {
    startTime: number;
    onChat?: (message: string, senderId: string) => Promise<string>;
    providerHealthCheck?: () => Promise<Record<string, boolean>>;
  }
): void {
  const router = gateway.getRouter();

  // Health check (public endpoint, no auth required)
  router.get("/api/health", async () => ({
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      uptime: Math.floor((Date.now() - deps.startTime) / 1000),
      version: "0.1.0",
    }),
  }));

  router.get("/health", async () => ({
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  }));

  // Chat endpoint
  router.post("/api/chat", async (req) => {
    if (!deps.onChat) {
      return {
        status: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Chat not available" }),
      };
    }

    let parsed: { message: string; senderId?: string };
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid JSON body" }),
      };
    }

    if (!parsed.message || typeof parsed.message !== "string") {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing 'message' field" }),
      };
    }

    const senderId = parsed.senderId ?? "api-user";
    const reply = await deps.onChat(parsed.message, senderId);
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    };
  });

  // Provider health
  router.get("/api/providers/health", async () => {
    if (!deps.providerHealthCheck) {
      return {
        status: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Provider health not available" }),
      };
    }

    const health = await deps.providerHealthCheck();
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(health),
    };
  });
}
