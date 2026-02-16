/**
 * @fileoverview Bridges Bun.serve to the GatewayServer middleware chain.
 * @module gateway/bun-server
 *
 * @note This module creates a real HTTP/WebSocket server using Bun's
 * native server API and delegates all request handling to the
 * existing GatewayServer which processes middleware chains.
 * Serves static web UI files from web/ (GET /, /index.html, /styles.css, /chat.ts).
 * All HTTP routes and WebSocket upgrades require a valid Bearer token.
 */

import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { Logger, MaiaConfig } from "../core/types.js";
import type { GatewayServer } from "./server.js";

/** MIME types for web UI static file extensions. */
const WEB_UI_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".ts": "application/javascript; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/**
 * @brief Serves a file from webRoot if pathName is a safe web UI asset path.
 * Supports both flat (web/) and nested (dashboard/dist/assets/) structures.
 * For SPA routing, returns index.html for non-API, non-file paths that don't
 * match a static asset.
 * @param pathName - Request path (e.g. "/", "/index.html", "/assets/main.js")
 * @param webRoot - Absolute path to the web root directory
 * @param method - GET or HEAD
 * @returns Promise resolving to Response with file body, or null if not a static asset or file missing
 */
async function serveWebAsset(
  pathName: string,
  webRoot: string,
  method: string
): Promise<Response | null> {
  if (method !== "GET" && method !== "HEAD") return null;

  // Prevent path traversal
  const normalized = path.normalize(pathName);
  if (normalized.includes("..")) return null;

  let filePath: string;

  if (pathName === "/" || pathName === "/index.html") {
    filePath = path.join(webRoot, "index.html");
  } else {
    // Support nested paths (e.g. /assets/main-abc123.js) for Vite builds
    const relativePath = pathName.slice(1);
    if (relativePath.startsWith(".")) return null;
    filePath = path.join(webRoot, relativePath);
  }

  const ext = path.extname(filePath);
  if (!Object.prototype.hasOwnProperty.call(WEB_UI_MIME, ext)) {
    // SPA fallback: for non-API paths with no file extension, serve index.html
    if (!pathName.startsWith("/api") && !pathName.startsWith("/ws") && !ext) {
      const indexPath = path.join(webRoot, "index.html");
      const indexFile = Bun.file(indexPath);
      if (await indexFile.exists()) {
        if (method === "HEAD") {
          return new Response(undefined, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(indexFile, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }
    return null;
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  if (method === "HEAD") {
    return new Response(undefined, {
      status: 200,
      headers: { "Content-Type": WEB_UI_MIME[ext] ?? "application/octet-stream" },
    });
  }

  if (ext === ".ts") {
    const text = await file.text();
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const js = transpiler.transformSync(text);
    return new Response(js, {
      status: 200,
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  }

  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": WEB_UI_MIME[ext] ?? "application/octet-stream",
    },
  });
}

/**
 * @brief Validates WebSocket auth token from request (query or header).
 * @param req - Incoming request (for /ws upgrade)
 * @param url - Parsed URL (for query param)
 * @param expectedToken - Configured gateway auth token
 * @returns true if token is valid
 */
function validateWSToken(req: Request, url: URL, expectedToken: string): boolean {
  const fromQuery = (url.searchParams.get("token") ?? "").trim();
  const fromHeader =
    req.headers.get("authorization")?.replace(/^\s*Bearer\s+/i, "").trim() ?? "";
  const token = (fromQuery || fromHeader).trim();
  const expected = (expectedToken ?? "").trim();
  if (!token || !expected) return false;
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @brief Callback invoked when a WebSocket client connects; receives connection ID
 * and a send function to push initial state (e.g. agents, threads) to that client.
 */
export type OnWsConnect = (
  connectionId: string,
  send: (data: string) => void
) => void | Promise<void>;

/**
 * @brief Options for starting the Bun HTTP server.
 */
export interface BunServerOptions {
  config: MaiaConfig;
  gateway: GatewayServer;
  logger: Logger;
  /** Optional getter for on-connect callback; called when a client connects so initial state can be sent. */
  getOnWsConnect?: () => OnWsConnect | undefined;
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
  /**
   * @brief Send a message to a specific WebSocket connection by ID.
   * @param connectionId - Connection ID
   * @param data - Message data (JSON string)
   */
  wsSend(connectionId: string, data: string): void;
  /**
   * @brief Broadcast a message to all connected WebSocket clients.
   * @param data - Message data (JSON string)
   */
  wsBroadcast(data: string): void;
}

/**
 * @brief Starts a Bun HTTP/WebSocket server bridged to the GatewayServer.
 * @param options - Server configuration, gateway instance, and logger
 * @returns BunServer with the running server, URL, and stop method
 *
 * @note The server:
 * - Delegates all HTTP requests to gatewayServer.handleRequest()
 * - Upgrades /ws connections to WebSocket and delegates to WSHandler
 * - Serves static web files from web/ for the webchat UI (GET /, /index.html, etc.)
 *
 * @example
 * const bunServer = startBunServer({ config, gateway, logger });
 * console.log(`Listening on ${bunServer.url}`);
 * // ... later ...
 * bunServer.stop();
 */
/**
 * @brief Resolves the web UI root directory (must contain index.html).
 * Prefers web/ (static Alpine + vanilla UI, no build). Fallback to dashboard/dist if web/ has no index.
 */
function resolveWebRoot(): string {
  const entryDir = path.dirname(Bun.main);
  const candidates = [
    path.resolve(process.cwd(), "web"),
    path.resolve(entryDir, "web"),
    path.resolve(entryDir, "..", "web"),
    path.resolve(import.meta.dir, "..", "..", "web"),
    path.resolve(process.cwd(), "dashboard", "dist"),
    path.resolve(entryDir, "dashboard", "dist"),
    path.resolve(entryDir, "..", "dashboard", "dist"),
  ];
  const indexName = "index.html";
  for (const dir of candidates) {
    if (existsSync(path.join(dir, indexName))) return dir;
  }
  return candidates[candidates.length - 1]!;
}

export function startBunServer(options: BunServerOptions): BunServer {
  const { config, gateway, logger, getOnWsConnect } = options;
  const wsHandler = gateway.getWSHandler();
  const webRoot = resolveWebRoot();
  logger.debug("Web UI root", { webRoot });

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

      // Serve web UI static files (GET /, /index.html, /styles.css, /chat.ts, etc.)
      const staticResponse = await serveWebAsset(pathName, webRoot, req.method);
      if (staticResponse) return staticResponse;

      // WebSocket upgrade (requires valid Bearer token via ?token= or Authorization header)
      if (pathName === "/ws" && wsHandler) {
        const expectedToken = config.gateway.auth?.token ?? "";
        if (!validateWSToken(req, url, expectedToken)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
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

      // Extract client IP: prefer proxy headers, then Bun's connection address.
      // When opening the page in a browser (no proxy), headers are absent and we
      // previously used "unknown", so all clients shared one rate-limit bucket
      // and could get 429 on first load.
      const ip =
        headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
        headers["x-real-ip"] ??
        server.requestIP?.(req)?.address ??
        "unknown";

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
        const onConnect = getOnWsConnect?.();
        if (onConnect) {
          const send = (data: string) => {
            try {
              ws.send(data);
            } catch (err) {
              logger.warn("Initial state send failed", {
                connectionId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          };
          Promise.resolve(onConnect(connectionId, send)).catch((err) => {
            logger.warn("OnWsConnect failed", {
              connectionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
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
  // Bypass logger redaction so user can verify token matches .env (remove or gate on debug in production)
  const authToken = config.gateway.auth?.token ?? "";
  if (authToken) {
    process.stdout.write(
      `[Maia] Gateway auth token (verification only): ${authToken}\n`
    );
  }

  return {
    server,
    url: serverUrl,
    stop() {
      server.stop(true);
      logger.info("Bun server stopped");
    },
    wsSend(connectionId: string, data: string): void {
      const entry = wsConnections.get(connectionId);
      if (entry) {
        try {
          (entry.ws as ServerWebSocket<WSData>).send(data);
        } catch (err) {
          logger.warn("wsSend failed", {
            connectionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    wsBroadcast(data: string): void {
      for (const [, entry] of wsConnections) {
        try {
          (entry.ws as ServerWebSocket<WSData>).send(data);
        } catch (err) {
          logger.warn("wsBroadcast send failed", {
            connectionId: entry.connectionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
    onChat?: (
      message: string,
      senderId: string
    ) => Promise<{ content: string; remembered?: { memoryMd?: string; userMd?: string; soulMd?: string } }>;
    providerHealthCheck?: () => Promise<Record<string, boolean>>;
  }
): void {
  const router = gateway.getRouter();

  // Health check (requires Bearer token like all other routes)
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
    const result = await deps.onChat(parsed.message, senderId);
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: result.content,
        ...(result.remembered && Object.keys(result.remembered).length > 0
          ? { remembered: result.remembered }
          : {}),
      }),
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
