/**
 * @fileoverview Integration tests for agent tools with real MemoryStore, SSRF guard, and registry.
 * @module tests/integration/agent-tools
 *
 * @note Exercises memory_search, memory_store, memory_forget, web_fetch execute() paths
 * and tool registry (register, get, list, definitions, execute with permission check).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createSQLiteDatabase } from "../../src/adapters/database.js";
import { createRealCryptoProvider } from "../../src/adapters/crypto.js";
import { createMemoryStore } from "../../src/memory/store.js";
import {
  createMemorySearchTool,
  createMemoryStoreTool,
  createMemoryForgetTool,
} from "../../src/agent/tools/memory-tools.js";
import { createWebFetchTool } from "../../src/agent/tools/web-fetch.js";
import { createToolRegistry } from "../../src/agent/tools/registry.js";
import { createSsrfGuard } from "../../src/security/ssrf-guard.js";
import { capturingLogger, mockHttpClient } from "../helpers/index.js";
import type {
  Database,
  MemoryStore,
  MemoryEntry,
  MemorySearchResult,
} from "../../src/core/types.js";
import type { ToolContext } from "../../src/agent/tools/base.js";

/** @brief Creates a MemoryStore that throws when the overridden method is called. */
function createThrowingStore(overrides: {
  search?: () => Promise<MemorySearchResult[]>;
  store?: () => Promise<MemoryEntry>;
  get?: () => Promise<MemoryEntry | null>;
  remove?: () => Promise<void>;
}): MemoryStore {
  return {
    search: overrides.search ?? (async () => []),
    store: overrides.store ?? (async () => ({ id: "x", text: "", category: "other", importance: 0.5, createdAt: "", updatedAt: "" })),
    get: overrides.get ?? (async () => null),
    remove: overrides.remove ?? (async () => {}),
    count: async () => 0,
  };
}

const defaultContext: ToolContext = {
  sessionId: "test-session",
  channelId: "cli",
  senderId: "user-1",
  privacyMode: false,
};

describe("Agent tools with real MemoryStore (integration)", () => {
  let db: Database;

  beforeEach(async () => {
    db = createSQLiteDatabase(":memory:");
    const sqlPath = path.resolve("src/core/migrations/migrations/001_initial_schema.sql");
    const sql = await fsNative.readFile(sqlPath, "utf-8");
    await db.execute(sql);
  });

  function createStore() {
    const crypto = createRealCryptoProvider();
    const logger = capturingLogger();
    return { store: createMemoryStore({ db, crypto, logger }), logger };
  }

  describe("memory_search tool", () => {
    it("should return definition with query and optional category and limit", () => {
      const { store, logger } = createStore();
      const tool = createMemorySearchTool({ store, logger });
      const def = tool.definition();
      expect(def.name).toBe("memory_search");
      expect(def.description).toContain("Search");
      expect(def.parameters?.properties?.query).toBeDefined();
      expect(def.parameters?.properties?.category?.enum).toContain("preference");
      expect(def.parameters?.properties?.limit).toBeDefined();
      expect(def.parameters?.required).toContain("query");
    });

    it("should return error when query is missing", async () => {
      const { store, logger } = createStore();
      const tool = createMemorySearchTool({ store, logger });
      const result = await tool.execute({}, defaultContext);
      expect(result.success).toBe(false);
      expect(result.content).toContain("query is required");
    });

    it("should return no memories message when search is empty", async () => {
      const { store, logger } = createStore();
      const tool = createMemorySearchTool({ store, logger });
      const result = await tool.execute({ query: "nonexistent" }, defaultContext);
      expect(result.success).toBe(true);
      expect(result.content).toContain("No memories found");
      expect(result.data).toEqual({ count: 0 });
    });

    it("should return error when store.search throws", async () => {
      const logger = capturingLogger();
      const store = createThrowingStore({
        search: async () => {
          throw new Error("database query failed");
        },
      });
      const tool = createMemorySearchTool({ store, logger });
      const result = await tool.execute({ query: "test" }, defaultContext);
      expect(result.success).toBe(false);
      expect(result.content).toContain("Memory search error");
      expect(result.content).toContain("database query failed");
    });

    it("should return formatted results when memories match", async () => {
      const { store, logger } = createStore();
      await store.store({
        text: "User prefers TypeScript",
        category: "preference",
        importance: 0.9,
      });
      const tool = createMemorySearchTool({ store, logger });
      const result = await tool.execute({ query: "TypeScript" }, defaultContext);
      expect(result.success).toBe(true);
      expect(result.content).toContain("Found 1 memories");
      expect(result.content).toContain("preference");
      expect(result.data?.count).toBe(1);
      expect(Array.isArray(result.data?.ids)).toBe(true);
    });

    it("should respect limit and category", async () => {
      const { store, logger } = createStore();
      await store.store({ text: "Fact one", category: "fact", importance: 0.5 });
      await store.store({ text: "Preference one", category: "preference", importance: 0.8 });
      const tool = createMemorySearchTool({ store, logger });
      const result = await tool.execute(
        { query: "one", category: "preference", limit: 1 },
        defaultContext
      );
      expect(result.success).toBe(true);
      expect(result.data?.count).toBeLessThanOrEqual(1);
    });
  });

  describe("memory_store tool", () => {
    it("should return definition with text, category, and importance", () => {
      const { store, logger } = createStore();
      const tool = createMemoryStoreTool({ store, logger });
      const def = tool.definition();
      expect(def.name).toBe("memory_store");
      expect(def.parameters?.properties?.text).toBeDefined();
      expect(def.parameters?.properties?.category?.enum).toContain("fact");
      expect(def.parameters?.properties?.importance).toBeDefined();
      expect(def.parameters?.required).toContain("text");
      expect(def.parameters?.required).toContain("category");
    });

    it("should skip store when privacy mode is active", async () => {
      const { store, logger } = createStore();
      const tool = createMemoryStoreTool({ store, logger });
      const result = await tool.execute(
        { text: "Secret", category: "preference" },
        { ...defaultContext, privacyMode: true }
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain("Privacy mode");
      expect(result.data?.skipped).toBe(true);
    });

    it("should return error when text is missing", async () => {
      const { store, logger } = createStore();
      const tool = createMemoryStoreTool({ store, logger });
      const result = await tool.execute({ category: "fact" }, defaultContext);
      expect(result.success).toBe(false);
      expect(result.content).toContain("text is required");
    });

    it("should return error for invalid category", async () => {
      const { store, logger } = createStore();
      const tool = createMemoryStoreTool({ store, logger });
      const result = await tool.execute(
        { text: "Hello", category: "invalid_category" },
        defaultContext
      );
      expect(result.success).toBe(false);
      expect(result.content).toContain("invalid category");
    });

    it("should store memory and return id", async () => {
      const { store, logger } = createStore();
      const tool = createMemoryStoreTool({ store, logger });
      const result = await tool.execute(
        { text: "User likes Bun", category: "preference", importance: 8 },
        defaultContext
      );
      expect(result.success).toBe(true);
      expect(result.content).toMatch(/Memory stored \(id: .+\)/);
      expect(result.data?.id).toBeTruthy();
      const got = await store.get(result.data!.id as string);
      expect(got?.text).toBe("User likes Bun");
    });

    it("should clamp importance to 1-10", async () => {
      const { store, logger } = createStore();
      const tool = createMemoryStoreTool({ store, logger });
      const result = await tool.execute(
        { text: "High importance", category: "fact", importance: 99 },
        defaultContext
      );
      expect(result.success).toBe(true);
      const got = await store.get(result.data!.id as string);
      expect(got?.importance).toBeLessThanOrEqual(10);
    });

    it("should return error when store.store throws", async () => {
      const logger = capturingLogger();
      const store = createThrowingStore({
        store: async () => {
          throw new Error("database write failed");
        },
      });
      const tool = createMemoryStoreTool({ store, logger });
      const result = await tool.execute(
        { text: "Fail", category: "fact" },
        defaultContext
      );
      expect(result.success).toBe(false);
      expect(result.content).toContain("Memory store error");
      expect(result.content).toContain("database write failed");
    });
  });

  describe("memory_forget tool", () => {
    it("should return definition with id parameter", () => {
      const { store, logger } = createStore();
      const tool = createMemoryForgetTool({ store, logger });
      const def = tool.definition();
      expect(def.name).toBe("memory_forget");
      expect(def.parameters?.properties?.id).toBeDefined();
      expect(def.parameters?.required).toContain("id");
    });

    it("should return error when id is missing", async () => {
      const { store, logger } = createStore();
      const tool = createMemoryForgetTool({ store, logger });
      const result = await tool.execute({}, defaultContext);
      expect(result.success).toBe(false);
      expect(result.content).toContain("id is required");
    });

    it("should return not found for non-existent id", async () => {
      const { store, logger } = createStore();
      const tool = createMemoryForgetTool({ store, logger });
      const result = await tool.execute({ id: "non-existent-id" }, defaultContext);
      expect(result.success).toBe(false);
      expect(result.content).toContain("not found");
    });

    it("should remove memory and return success", async () => {
      const { store, logger } = createStore();
      const entry = await store.store({
        text: "To forget",
        category: "other",
        importance: 0.5,
      });
      const tool = createMemoryForgetTool({ store, logger });
      const result = await tool.execute({ id: entry.id }, defaultContext);
      expect(result.success).toBe(true);
      expect(result.content).toContain("has been removed");
      const got = await store.get(entry.id);
      expect(got).toBeNull();
    });

    it("should return error when store.get throws", async () => {
      const logger = capturingLogger();
      const store = createThrowingStore({
        get: async () => {
          throw new Error("connection lost");
        },
      });
      const tool = createMemoryForgetTool({ store, logger });
      const result = await tool.execute({ id: "some-id" }, defaultContext);
      expect(result.success).toBe(false);
      expect(result.content).toContain("Memory forget error");
      expect(result.content).toContain("connection lost");
    });

    it("should return error when store.remove throws", async () => {
      const logger = capturingLogger();
      const existing: MemoryEntry = {
        id: "existing-id",
        text: "x",
        category: "other",
        importance: 0.5,
        createdAt: "",
        updatedAt: "",
      };
      const store = createThrowingStore({
        get: async () => existing,
        remove: async () => {
          throw new Error("delete failed");
        },
      });
      const tool = createMemoryForgetTool({ store, logger });
      const result = await tool.execute({ id: "existing-id" }, defaultContext);
      expect(result.success).toBe(false);
      expect(result.content).toContain("Memory forget error");
      expect(result.content).toContain("delete failed");
    });
  });
});

describe("web_fetch tool (integration)", () => {
  it("should return error when URL is missing", async () => {
    const logger = capturingLogger();
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    const http = mockHttpClient(new Map());
    const tool = createWebFetchTool({ http, ssrfGuard: guard, logger });
    const result = await tool.execute({}, defaultContext);
    expect(result.success).toBe(false);
    expect(result.content).toContain("URL is required");
  });

  it("should block private URL via SSRF guard", async () => {
    const logger = capturingLogger();
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    const http = mockHttpClient(new Map([["http://127.0.0.1/", { status: 200, headers: {}, body: "ok", ok: true }]]));
    const tool = createWebFetchTool({ http, ssrfGuard: guard, logger });
    const result = await tool.execute({ url: "http://127.0.0.1/" }, defaultContext);
    expect(result.success).toBe(false);
    expect(result.content).toContain("blocked");
    expect(http.calls).toHaveLength(0);
  });

  it("should fetch public URL and return body", async () => {
    const logger = capturingLogger();
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    const http = mockHttpClient(
      new Map([
        [
          "https://example.com/",
          { status: 200, headers: {}, body: "Hello from example", ok: true },
        ],
      ])
    );
    const tool = createWebFetchTool({ http, ssrfGuard: guard, logger });
    const result = await tool.execute({ url: "https://example.com/" }, defaultContext);
    expect(result.success).toBe(true);
    expect(result.content).toContain("Status: 200");
    expect(result.content).toContain("Hello from example");
    expect(result.data?.bodyLength).toBe(18);
    expect(http.calls).toHaveLength(1);
  });

  it("should truncate long response body", async () => {
    const longBody = "x".repeat(15000);
    const logger = capturingLogger();
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    const http = mockHttpClient(
      new Map([["https://example.com/", { status: 200, headers: {}, body: longBody, ok: true }]])
    );
    const tool = createWebFetchTool({ http, ssrfGuard: guard, logger, maxResponseLength: 100 });
    const result = await tool.execute({ url: "https://example.com/" }, defaultContext);
    expect(result.success).toBe(true);
    expect(result.content).toContain("...[truncated]");
  });

  it("should return definition with name, description, and parameters", () => {
    const logger = capturingLogger();
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    const http = mockHttpClient(new Map());
    const tool = createWebFetchTool({ http, ssrfGuard: guard, logger });
    const def = tool.definition();
    expect(def.name).toBe("web_fetch");
    expect(def.description).toContain("public URL");
    expect(def.parameters?.properties?.url).toBeDefined();
    expect(def.parameters?.properties?.method?.enum).toEqual(["GET", "POST"]);
    expect(def.parameters?.required).toContain("url");
  });

  it("should return error when http.fetch throws", async () => {
    const logger = capturingLogger();
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    const http = {
      fetch: async () => {
        throw new Error("network timeout");
      },
    };
    const tool = createWebFetchTool({ http, ssrfGuard: guard, logger });
    const result = await tool.execute({ url: "https://example.com/" }, defaultContext);
    expect(result.success).toBe(false);
    expect(result.content).toContain("Error fetching");
    expect(result.content).toContain("network timeout");
  });

  it("should support POST method", async () => {
    const logger = capturingLogger();
    const guard = createSsrfGuard({ blockPrivateIPs: true });
    const http = mockHttpClient(
      new Map([
        [
          "https://api.example.com/",
          { status: 201, headers: {}, body: "created", ok: true },
        ],
      ])
    );
    const tool = createWebFetchTool({ http, ssrfGuard: guard, logger });
    const result = await tool.execute({
      url: "https://api.example.com/",
      method: "POST",
    }, defaultContext);
    expect(result.success).toBe(true);
    expect(result.content).toContain("Status: 201");
  });
});

describe("Tool registry (integration)", () => {
  let db: Database;

  beforeEach(async () => {
    db = createSQLiteDatabase(":memory:");
    const sqlPath = path.resolve("src/core/migrations/migrations/001_initial_schema.sql");
    const sql = await fsNative.readFile(sqlPath, "utf-8");
    await db.execute(sql);
  });

  it("should register tool and return via get", () => {
    const logger = capturingLogger();
    const crypto = createRealCryptoProvider();
    const store = createMemoryStore({ db, crypto, logger });
    const registry = createToolRegistry({ logger });
    const tool = createMemorySearchTool({ store, logger });
    registry.register(tool);
    expect(registry.get("memory_search")).toBe(tool);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should list and definitions include registered tools", () => {
    const logger = capturingLogger();
    const crypto = createRealCryptoProvider();
    const store = createMemoryStore({ db, crypto, logger });
    const registry = createToolRegistry({ logger });
    registry.register(createMemorySearchTool({ store, logger }));
    registry.register(createMemoryStoreTool({ store, logger }));
    expect(registry.list()).toContain("memory_search");
    expect(registry.list()).toContain("memory_store");
    const defs = registry.definitions();
    expect(defs).toHaveLength(2);
    expect(defs.some((d) => d.name === "memory_search")).toBe(true);
  });

  it("should throw when registering duplicate tool name", () => {
    const logger = capturingLogger();
    const crypto = createRealCryptoProvider();
    const store = createMemoryStore({ db, crypto, logger });
    const registry = createToolRegistry({ logger });
    registry.register(createMemorySearchTool({ store, logger }));
    expect(() => registry.register(createMemorySearchTool({ store, logger }))).toThrow(
      "Tool already registered"
    );
  });

  it("should execute tool when allowed", async () => {
    const logger = capturingLogger();
    const crypto = createRealCryptoProvider();
    const store = createMemoryStore({ db, crypto, logger });
    const registry = createToolRegistry({ logger });
    registry.register(createMemorySearchTool({ store, logger }));
    const result = await registry.execute(
      "memory_search",
      { query: "test" },
      defaultContext
    );
    expect(result.success).toBe(true);
  });

  it("should return not found when tool name is unknown", async () => {
    const logger = capturingLogger();
    const registry = createToolRegistry({ logger });
    const result = await registry.execute("fake_tool", { x: 1 }, defaultContext);
    expect(result.success).toBe(false);
    expect(result.content).toContain("not found");
  });

  it("should deny execution when isAllowed returns false", async () => {
    const logger = capturingLogger();
    const crypto = createRealCryptoProvider();
    const store = createMemoryStore({ db, crypto, logger });
    const registry = createToolRegistry({
      logger,
      isAllowed: () => false,
    });
    registry.register(createMemorySearchTool({ store, logger }));
    const result = await registry.execute(
      "memory_search",
      { query: "test" },
      defaultContext
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("Permission denied");
  });

  it("should return failure when tool execute throws", async () => {
    const logger = capturingLogger();
    const registry = createToolRegistry({ logger });
    const throwingTool = {
      name: "throwing_tool",
      description: "Throws",
      definition: () => ({ name: "throwing_tool", description: "Throws", parameters: { type: "object", properties: {} } }),
      execute: async () => {
        throw new Error("tool crashed");
      },
    };
    registry.register(throwingTool);
    const result = await registry.execute(
      "throwing_tool",
      {},
      defaultContext
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("failed");
    expect(result.content).toContain("tool crashed");
  });
});
