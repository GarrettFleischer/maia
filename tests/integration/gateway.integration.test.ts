/**
 * @fileoverview Integration tests for the gateway: handleRequest through full middleware
 * chain and registered API routes.
 * @module tests/integration/gateway
 *
 * @note Uses createApp() then builds GatewayServer the same way index.ts does (router,
 * auth, rate limit, CORS, error handler, WS handler, registerApiRoutes). Exercises
 * server.ts and route handling without starting Bun.serve.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createApp } from "../../src/app.js";
import { createRouter } from "../../src/gateway/router.js";
import { createAuthMiddleware } from "../../src/gateway/middleware/auth.js";
import { createRateLimitMiddleware } from "../../src/gateway/middleware/rate-limit.js";
import { createCorsMiddleware } from "../../src/gateway/middleware/cors.js";
import { createErrorHandler } from "../../src/gateway/middleware/error-handler.js";
import { createGatewayServer } from "../../src/gateway/server.js";
import { createWSHandler } from "../../src/gateway/ws-handler.js";
import { registerApiRoutes } from "../../src/gateway/bun-server.js";

describe("Gateway with full middleware chain (integration)", () => {
  const tmpDir = path.join(os.tmpdir(), `maia-gateway-test-${Date.now()}`);
  const configPath = path.join(tmpDir, "maia.config.json");
  const dataDir = path.join(tmpDir, "data");
  const workspaceDir = path.join(tmpDir, "workspace");
  const authToken = "gateway-test-token-16chars!!";

  beforeAll(async () => {
    await fsNative.mkdir(dataDir, { recursive: true });
    await fsNative.mkdir(workspaceDir, { recursive: true });
    const config = {
      identity: { name: "TestMaia", emoji: "🧪", personality: "test" },
      workspace: { path: workspaceDir },
      provider: {
        primary: "ollama",
        model: "test-model",
        ollama: { baseUrl: "http://localhost:99999" },
      },
      gateway: {
        port: 39999,
        host: "127.0.0.1",
        auth: { token: authToken },
        cors: { origins: ["https://app.example.com"] },
      },
      channels: { cli: { enabled: true }, webchat: { enabled: false }, discord: { enabled: false }, telegram: { enabled: false } },
      memory: { enabled: true },
      security: { sandbox: { enabled: true, root: tmpDir }, rateLimiting: { maxRequests: 100, windowMs: 60000 } },
    };
    await fsNative.writeFile(configPath, JSON.stringify(config));
    process.env.MAIA_AUTH_TOKEN = authToken;
    process.env.MAIA_MASTER_KEY = "test-master-key-for-gateway";
  });

  afterAll(async () => {
    delete process.env.MAIA_AUTH_TOKEN;
    delete process.env.MAIA_MASTER_KEY;
    try {
      await fsNative.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  async function createGateway() {
    const app = await createApp({ configPath, dataDir });
    const ctx = app.getContext();
    const runtime = app.getRuntime();
    const providerRegistry = app.getProviderRegistry();

    const router = createRouter({ logger: ctx.logger });
    const authMiddleware = createAuthMiddleware(ctx);
    const rateLimitMiddleware = createRateLimitMiddleware(ctx);
    const corsMiddleware = createCorsMiddleware({
      allowedOrigins: ctx.config.gateway.cors.origins,
      logger: ctx.logger,
    });
    const errorHandler = createErrorHandler({ logger: ctx.logger });
    const wsHandler = createWSHandler({
      logger: ctx.logger,
      events: ctx.events,
      onChatMessage: async (_connectionId, senderId, content) => {
        const msg = {
          id: ctx.crypto.randomUUID(),
          channelId: "webchat",
          senderId,
          content,
          timestamp: ctx.clock.timestamp(),
          isGroup: false,
        };
        return await runtime.handleMessage(msg);
      },
    });

    const gateway = createGatewayServer({
      ctx,
      router,
      authMiddleware,
      rateLimitMiddleware,
      corsMiddleware,
      errorHandler,
      wsHandler,
    });

    registerApiRoutes(gateway, {
      startTime: Date.now(),
      onChat: async (message, senderId) => {
        const inbound = {
          id: ctx.crypto.randomUUID(),
          channelId: "api",
          senderId,
          content: message,
          timestamp: ctx.clock.timestamp(),
          isGroup: false,
        };
        return await runtime.handleMessage(inbound);
      },
      providerHealthCheck: async () => {
        const status = await providerRegistry.healthStatus();
        const result: Record<string, boolean> = {};
        for (const [id, healthy] of status) {
          result[id] = healthy;
        }
        return result;
      },
    });

    return { app, gateway, ctx };
  }

  it("should return 200 for GET /api/health without auth", async () => {
    const { app, gateway } = await createGateway();
    const res = await gateway.handleRequest("GET", "/api/health", {}, "", "127.0.0.1");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
    await app.stop();
  });

  it("should return 200 for GET /health", async () => {
    const { app, gateway } = await createGateway();
    const res = await gateway.handleRequest("GET", "/health", {}, "", "127.0.0.1");
    expect(res.status).toBe(200);
    await app.stop();
  });

  it("should return 401 for protected route without auth", async () => {
    const { app, gateway } = await createGateway();
    const res = await gateway.handleRequest("GET", "/api/chat", {}, "", "127.0.0.1");
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    await app.stop();
  });

  it("should return 404 for unknown path when authenticated", async () => {
    const { app, gateway } = await createGateway();
    const headers = { authorization: `Bearer ${authToken}` };
    const res = await gateway.handleRequest("GET", "/nonexistent", headers, "", "127.0.0.1");
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Not found");
    await app.stop();
  });

  it("should return 403 when CORS origin is not allowed", async () => {
    const { app, gateway } = await createGateway();
    const res = await gateway.handleRequest("GET", "/api/health", { origin: "https://evil.com" }, "", "127.0.0.1");
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("CORS");
    await app.stop();
  });

  it("should return 204 for OPTIONS preflight when origin allowed", async () => {
    const { app, gateway } = await createGateway();
    const res = await gateway.handleRequest("OPTIONS", "/api/health", { origin: "https://app.example.com" }, "", "127.0.0.1");
    expect(res.status).toBe(204);
    await app.stop();
  });

  it("should return 200 and provider health for GET /api/providers/health with auth", async () => {
    const { app, gateway } = await createGateway();
    const res = await gateway.handleRequest("GET", "/api/providers/health", { authorization: `Bearer ${authToken}` }, "", "127.0.0.1");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body).toBe("object");
    expect(body.ollama === true || body.ollama === false).toBe(true);
    await app.stop();
  });

  it("should accept POST /api/chat with valid auth and return JSON", async () => {
    const { app, gateway } = await createGateway();
    const headers = { "content-type": "application/json", authorization: `Bearer ${authToken}` };
    const body = JSON.stringify({ message: "Hello" });
    const res = await gateway.handleRequest("POST", "/api/chat", headers, body, "127.0.0.1");
    const parsed = JSON.parse(res.body);
    expect(parsed).toBeDefined();
    if (res.status === 200) {
      expect(parsed.reply).toBeDefined();
    } else {
      expect(res.status).toBe(500);
      expect(parsed.code ?? parsed.message).toBeDefined();
    }
    await app.stop();
  });

  it("should return router from getRouter()", async () => {
    const { app, gateway } = await createGateway();
    const router = gateway.getRouter();
    expect(router).toBeTruthy();
    expect(typeof router.handle).toBe("function");
    await app.stop();
  });

  it("should return WSHandler from getWSHandler() when configured", async () => {
    const { app, gateway } = await createGateway();
    const wsHandler = gateway.getWSHandler();
    expect(wsHandler).toBeDefined();
    expect(wsHandler).toBeTruthy();
    await app.stop();
  });
});
