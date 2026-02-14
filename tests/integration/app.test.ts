/**
 * @fileoverview Composition smoke test for createApp().
 * @module tests/integration/app
 *
 * @note Boots the full application composition root with a temp directory
 * and a test config. Verifies the entire dependency graph wires correctly.
 * Does NOT require a running LLM -- just proves wiring is correct.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createApp } from "../../src/app.js";

describe("createApp() composition smoke test", () => {
  const tmpDir = path.join(os.tmpdir(), `maia-app-test-${Date.now()}`);
  const configPath = path.join(tmpDir, "maia.config.json");
  const dataDir = path.join(tmpDir, "data");
  const workspaceDir = path.join(tmpDir, "workspace");

  beforeAll(async () => {
    await fsNative.mkdir(dataDir, { recursive: true });
    await fsNative.mkdir(workspaceDir, { recursive: true });

    // Write a minimal config that points to our temp dirs
    const config = {
      identity: { name: "TestMaia", emoji: "🧪", personality: "test bot" },
      workspace: { path: workspaceDir },
      provider: {
        primary: "ollama",
        model: "test-model",
        ollama: { baseUrl: "http://localhost:99999" }, // non-existent, won't actually connect
      },
      gateway: {
        port: 39999, // won't actually start a server in this test
        auth: { token: "test-token-abc" },
      },
      channels: {
        cli: { enabled: true },
        webchat: { enabled: false },
        discord: { enabled: false },
        telegram: { enabled: false },
      },
      memory: { enabled: true },
      security: {
        sandbox: { enabled: true, root: tmpDir },
      },
    };
    await fsNative.writeFile(configPath, JSON.stringify(config));

    // Set env vars the app needs
    process.env.MAIA_AUTH_TOKEN = "test-token-abc";
    process.env.MAIA_MASTER_KEY = "test-master-key-for-integration";
  });

  afterAll(async () => {
    delete process.env.MAIA_AUTH_TOKEN;
    delete process.env.MAIA_MASTER_KEY;
    // On Windows, SQLite WAL files may briefly hold locks; retry cleanup
    try {
      await fsNative.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; OS temp dir will eventually be cleaned
    }
  });

  it("should create an app instance without throwing", async () => {
    const app = await createApp({ configPath, dataDir });
    expect(app).toBeTruthy();
    await app.stop();
  });

  it("should provide a valid MaiaContext", async () => {
    const app = await createApp({ configPath, dataDir });
    const ctx = app.getContext();

    expect(ctx.config).toBeTruthy();
    expect(ctx.config.identity.name).toBe("TestMaia");
    expect(ctx.fs).toBeTruthy();
    expect(ctx.clock).toBeTruthy();
    expect(ctx.env).toBeTruthy();
    expect(ctx.http).toBeTruthy();
    expect(ctx.crypto).toBeTruthy();
    expect(ctx.db).toBeTruthy();
    expect(ctx.logger).toBeTruthy();
    expect(ctx.events).toBeTruthy();
    expect(ctx.credentials).toBeTruthy();
    expect(ctx.auditLog).toBeTruthy();
    expect(ctx.shutdown).toBeTruthy();

    await app.stop();
  });

  it("should provide an AgentRuntime", async () => {
    const app = await createApp({ configPath, dataDir });
    const runtime = app.getRuntime();

    expect(runtime).toBeTruthy();
    expect(typeof runtime.handleMessage).toBe("function");
    expect(typeof runtime.getSessionId).toBe("function");

    await app.stop();
  });

  it("should provide a ProviderRegistry", async () => {
    const app = await createApp({ configPath, dataDir });
    const registry = app.getProviderRegistry();

    expect(registry).toBeTruthy();
    expect(typeof registry.get).toBe("function");
    expect(typeof registry.getPrimary).toBe("function");

    await app.stop();
  });

  it("should complete graceful shutdown", async () => {
    const app = await createApp({ configPath, dataDir });
    const ctx = app.getContext();

    // Register a test hook to verify shutdown runs
    let hookRan = false;
    ctx.shutdown.register("test-hook", async () => {
      hookRan = true;
    });

    await app.stop();
    expect(hookRan).toBe(true);
  });

  it("should have run database migrations", async () => {
    const app = await createApp({ configPath, dataDir });
    const ctx = app.getContext();

    // Verify the memories table exists by querying it
    const rows = await ctx.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
    );
    expect(rows).toHaveLength(1);

    await app.stop();
  });
});
