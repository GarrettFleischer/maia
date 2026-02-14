/**
 * @fileoverview Unit tests for agent registry (CRUD, workspace, persistence).
 * @module tests/unit/agents/registry
 */

import { describe, it, expect } from "bun:test";
import { createAgentRegistry } from "../../../src/agents/registry.js";
import type { AgentConfig } from "../../../src/agents/registry.js";
import {
  inMemoryFileSystem,
  inMemoryDatabase,
  capturingLogger,
} from "../../helpers/index.js";

function sampleConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "research-bot",
    name: "ResearchBot",
    emoji: "🔍",
    personality: "thorough researcher",
    createdBy: "maia",
    schedule: "0 9 * * *",
    tools: ["web_fetch", "memory_search"],
    model: { provider: "gemini", model: "gemini-2.0-flash" },
    ...overrides,
  };
}

function makeRegistry() {
  const fs = inMemoryFileSystem();
  const db = inMemoryDatabase();
  const logger = capturingLogger();
  const registry = createAgentRegistry({
    fs,
    db,
    logger,
    workspacePath: "/workspace",
  });
  return { registry, fs, db, logger };
}

describe("AgentRegistry", () => {
  describe("register", () => {
    it("should create workspace dirs and template files", async () => {
      const { registry, fs } = makeRegistry();
      await registry.register(sampleConfig());

      // Check template files were written
      expect(fs.files.has("/workspace/agents/research-bot/SOUL.md")).toBe(true);
      expect(fs.files.has("/workspace/agents/research-bot/IDENTITY.md")).toBe(true);
      expect(fs.files.has("/workspace/agents/research-bot/AGENTS.md")).toBe(true);
      expect(fs.files.has("/workspace/agents/research-bot/USER.md")).toBe(true);
      expect(fs.files.has("/workspace/agents/research-bot/MEMORY.md")).toBe(true);
      expect(fs.files.has("/workspace/agents/research-bot/TOOLS.md")).toBe(true);
      expect(fs.files.has("/workspace/agents/research-bot/agent.config.json")).toBe(true);
    });

    it("should write personality to SOUL.md", async () => {
      const { registry, fs } = makeRegistry();
      await registry.register(sampleConfig());

      const soul = fs.files.get("/workspace/agents/research-bot/SOUL.md")!;
      expect(soul).toContain("thorough researcher");
    });

    it("should use custom instructions for AGENTS.md when provided", async () => {
      const { registry, fs } = makeRegistry();
      await registry.register(sampleConfig({ instructions: "Custom instructions here" }));

      const agents = fs.files.get("/workspace/agents/research-bot/AGENTS.md")!;
      expect(agents).toBe("Custom instructions here");
    });

    it("should insert into database", async () => {
      const { registry, db } = makeRegistry();
      await registry.register(sampleConfig());

      const insertSql = db.executedSql.find((s) => s.sql.includes("INSERT"));
      expect(insertSql).toBeDefined();
      expect(insertSql!.params![0]).toBe("research-bot");
      expect(insertSql!.params![1]).toBe("ResearchBot");
    });

    it("should return config with timestamps", async () => {
      const { registry } = makeRegistry();
      const result = await registry.register(sampleConfig());

      expect(result.createdAt).toBeDefined();
      expect(result.active).toBe(true);
      expect(result.id).toBe("research-bot");
    });

    it("should write agent.config.json with valid JSON", async () => {
      const { registry, fs } = makeRegistry();
      await registry.register(sampleConfig());

      const raw = fs.files.get("/workspace/agents/research-bot/agent.config.json")!;
      const parsed = JSON.parse(raw);
      expect(parsed.id).toBe("research-bot");
      expect(parsed.name).toBe("ResearchBot");
    });
  });

  describe("get", () => {
    it("should return config for existing agent", async () => {
      const { registry } = makeRegistry();
      await registry.register(sampleConfig());

      const result = await registry.get("research-bot");
      expect(result).toBeDefined();
      expect(result!.id).toBe("research-bot");
      expect(result!.name).toBe("ResearchBot");
    });

    it("should return undefined for missing agent", async () => {
      const { registry } = makeRegistry();
      const result = await registry.get("nonexistent");
      expect(result).toBeUndefined();
    });

    it("should return undefined for invalid JSON and log warning", async () => {
      const { registry, fs, logger } = makeRegistry();
      fs.files.set("/workspace/agents/bad-agent/agent.config.json", "not json{{{");

      const result = await registry.get("bad-agent");
      expect(result).toBeUndefined();
      expect(logger.calls.some((c) => c.level === "warn")).toBe(true);
    });
  });

  describe("list", () => {
    it("should return all registered agents", async () => {
      const { registry } = makeRegistry();
      await registry.register(sampleConfig({ id: "bot-a", name: "BotA" }));
      await registry.register(sampleConfig({ id: "bot-b", name: "BotB" }));

      const agents = await registry.list();
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.id).sort()).toEqual(["bot-a", "bot-b"]);
    });

    it("should return empty array when agents dir does not exist", async () => {
      const { registry } = makeRegistry();
      const agents = await registry.list();
      expect(agents).toEqual([]);
    });

    it("should skip directories without agent.config.json", async () => {
      const { registry, fs } = makeRegistry();
      await registry.register(sampleConfig());
      // Create a dir without config (simulate an orphan)
      fs.files.set("/workspace/agents/orphan/some-file.txt", "junk");

      const agents = await registry.list();
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe("research-bot");
    });
  });

  describe("remove", () => {
    it("should delete DB row and workspace, return true", async () => {
      const { registry, db } = makeRegistry();
      await registry.register(sampleConfig());

      const result = await registry.remove("research-bot");
      expect(result).toBe(true);
      expect(db.executedSql.some((s) => s.sql.includes("DELETE"))).toBe(true);
    });

    it("should return false for non-existent agent", async () => {
      const { registry } = makeRegistry();
      const result = await registry.remove("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("update", () => {
    it("should merge partial changes and persist", async () => {
      const { registry, fs } = makeRegistry();
      await registry.register(sampleConfig());

      const updated = await registry.update("research-bot", { name: "NewName", schedule: "0 10 * * *" });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("NewName");
      expect(updated!.schedule).toBe("0 10 * * *");
      // id unchanged
      expect(updated!.id).toBe("research-bot");

      // Check disk
      const raw = fs.files.get("/workspace/agents/research-bot/agent.config.json")!;
      const onDisk = JSON.parse(raw);
      expect(onDisk.name).toBe("NewName");
    });

    it("should preserve id even if included in changes", async () => {
      const { registry } = makeRegistry();
      await registry.register(sampleConfig());

      const updated = await registry.update("research-bot", { id: "hacked" } as Partial<AgentConfig>);
      expect(updated!.id).toBe("research-bot");
    });

    it("should return undefined for non-existent agent", async () => {
      const { registry } = makeRegistry();
      const updated = await registry.update("nonexistent", { name: "X" });
      expect(updated).toBeUndefined();
    });
  });

  describe("agentWorkspacePath", () => {
    it("should return correct path", () => {
      const { registry } = makeRegistry();
      expect(registry.agentWorkspacePath("my-agent")).toBe("/workspace/agents/my-agent");
    });
  });
});
