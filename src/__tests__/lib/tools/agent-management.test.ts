import { describe, it, expect, beforeEach } from "bun:test";
import path from "path";
import {
  agentCreateTool,
  agentDeleteTool,
  agentListTool,
  agentGetTool,
  settingsListWhitelistedModelsTool,
  copyDefaultAgentFiles,
} from "@/lib/tools/agent-management";
import { getAgentsDir, getDefaultAgentDir, getDefaultMaiaDir } from "@/lib/data-dir";
import { makeTestContext, FakeFs } from "../../helpers/fakes";
import { updateSettings } from "@/lib/settings";
import type { ToolContext } from "@/lib/tools/types";
import type { AgentDefinition } from "@/lib/types";

function makeToolCtx(fs?: FakeFs): ToolContext {
  const fakefs = fs ?? new FakeFs();
  const ctx = makeTestContext({ fs: fakefs });
  // Whitelist a model for tests
  updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"] });
  return { ...ctx, agentId: "maia", sessionId: "session-1", volumeRoot: "/workspace" };
}

describe("settingsListWhitelistedModelsTool", () => {
  it("returns whitelisted models from settings", async () => {
    const ctx = makeToolCtx();
    const result = await settingsListWhitelistedModelsTool.execute({}, ctx) as { whitelistedModels: string[] };
    expect(result.whitelistedModels).toEqual(["ollama/llama3.2"]);
  });

  it("returns empty array when whitelist is empty", async () => {
    const ctx = makeToolCtx();
    updateSettings(ctx, { whitelistedModels: [] });
    const result = await settingsListWhitelistedModelsTool.execute({}, ctx) as { whitelistedModels: string[] };
    expect(result.whitelistedModels).toEqual([]);
  });

  it("returns multiple models when configured", async () => {
    const ctx = makeToolCtx();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2", "openrouter/anthropic/claude-3.5-sonnet"] });
    const result = await settingsListWhitelistedModelsTool.execute({}, ctx) as { whitelistedModels: string[] };
    expect(result.whitelistedModels).toEqual(["ollama/llama3.2", "openrouter/anthropic/claude-3.5-sonnet"]);
  });
});

describe("copyDefaultAgentFiles", () => {
  it("uses defaults/maia/AGENTS.md for Maia when present", () => {
    const fs = new FakeFs();
    const maiaAgentsPath = path.join(getDefaultMaiaDir(), "AGENTS.md");
    const maiaContent = "# Maia only\n\n## Creating agents (Maia)\nUse settings_list_whitelisted_models.";
    fs.seed(maiaAgentsPath, maiaContent);
    const ctx = makeTestContext({ fs });
    const agentDir = path.join(getAgentsDir(), "maia");
    copyDefaultAgentFiles(ctx, agentDir, "Maia", "maia");
    const written = fs.snapshot()[path.join(agentDir, "AGENTS.md")];
    expect(written).toBe(maiaContent);
  });

  it("falls back to defaults/agent AGENTS.md for Maia when defaults/maia/AGENTS.md is missing", () => {
    const fs = new FakeFs();
    const agentAgentsPath = path.join(getDefaultAgentDir(), "AGENTS.md");
    const agentContent = "# Other agents\nNo Maia-only sections.";
    fs.seed(agentAgentsPath, agentContent);
    const ctx = makeTestContext({ fs });
    const agentDir = path.join(getAgentsDir(), "maia");
    copyDefaultAgentFiles(ctx, agentDir, "Maia", "maia");
    const written = fs.snapshot()[path.join(agentDir, "AGENTS.md")];
    expect(written).toBe(agentContent);
  });

  it("uses defaults/maia SOUL.md, MEMORY.md, USER.md for Maia when present", () => {
    const fs = new FakeFs();
    const maiaSoul = "# Soul\n\nI am Maia, the orchestrator.";
    const maiaMemory = "# Memory\n\nNo memories yet.";
    const maiaUser = "# User\n\nNo user information yet.";
    fs.seed(path.join(getDefaultMaiaDir(), "SOUL.md"), maiaSoul);
    fs.seed(path.join(getDefaultMaiaDir(), "MEMORY.md"), maiaMemory);
    fs.seed(path.join(getDefaultMaiaDir(), "USER.md"), maiaUser);
    const ctx = makeTestContext({ fs });
    const agentDir = path.join(getAgentsDir(), "maia");
    copyDefaultAgentFiles(ctx, agentDir, "Maia", "maia");
    const snap = fs.snapshot();
    expect(snap[path.join(agentDir, "SOUL.md")]).toBe(maiaSoul);
    expect(snap[path.join(agentDir, "MEMORY.md")]).toBe(maiaMemory);
    expect(snap[path.join(agentDir, "USER.md")]).toBe(maiaUser);
  });
});

describe("agentCreateTool", () => {
  it("creates an agent and returns its ID", async () => {
    const ctx = makeToolCtx();
    const id = await agentCreateTool.execute({
      name: "TestBot",
      model: "ollama/llama3.2",
      soul: "# Soul\nI help with testing.",
    }, ctx);
    expect(typeof id).toBe("string");
    expect((id as string).length).toBeGreaterThan(0);
  });

  it("persists agent in the database", async () => {
    const ctx = makeToolCtx();
    const id = await agentCreateTool.execute({ name: "MyBot", model: "ollama/llama3.2" }, ctx);
    const row = ctx.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.name).toBe("MyBot");
    expect(row.model).toBe("ollama/llama3.2");
  });

  it("writes identity files to fs", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    const id = await agentCreateTool.execute({
      name: "FileBot",
      model: "ollama/llama3.2",
      soul: "Custom soul",
      memory: "Custom memory",
    }, ctx);
    const snap = fs.snapshot();
    const keys = Object.keys(snap);
    expect(keys.some((k) => k.includes(id as string) && k.endsWith("SOUL.md"))).toBe(true);
    expect(keys.some((k) => k.includes(id as string) && k.endsWith("MEMORY.md"))).toBe(true);
    expect(keys.some((k) => k.includes(id as string) && k.endsWith("AGENTS.md"))).toBe(true);
  });

  it("throws when model is not whitelisted", async () => {
    const ctx = makeToolCtx();
    await expect(agentCreateTool.execute({ name: "Bot", model: "openrouter/gpt-evil" }, ctx)).rejects.toThrow();
  });
});

describe("agentDeleteTool", () => {
  it("soft-deletes an agent (sets status=deleted)", async () => {
    const ctx = makeToolCtx();
    const id = await agentCreateTool.execute({ name: "DeleteMe", model: "ollama/llama3.2" }, ctx);
    await agentDeleteTool.execute({ agentId: id as string }, ctx);
    const row = ctx.db.prepare("SELECT status FROM agents WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("deleted");
  });
});

describe("agentListTool", () => {
  it("returns empty list when no agents", async () => {
    const ctx = makeToolCtx();
    const result = await agentListTool.execute({}, ctx);
    expect(result).toEqual([]);
  });

  it("returns active and non-deleted agents", async () => {
    const ctx = makeToolCtx();
    await agentCreateTool.execute({ name: "Bot1", model: "ollama/llama3.2" }, ctx);
    await agentCreateTool.execute({ name: "Bot2", model: "ollama/llama3.2" }, ctx);
    const result = await agentListTool.execute({}, ctx) as AgentDefinition[];
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.name)).toContain("Bot1");
    expect(result.map((a) => a.name)).toContain("Bot2");
  });

  it("excludes deleted agents", async () => {
    const ctx = makeToolCtx();
    const id = await agentCreateTool.execute({ name: "Deleted", model: "ollama/llama3.2" }, ctx);
    await agentDeleteTool.execute({ agentId: id as string }, ctx);
    const result = await agentListTool.execute({}, ctx) as AgentDefinition[];
    expect(result.every((a) => a.name !== "Deleted")).toBe(true);
  });
});

describe("agentGetTool", () => {
  it("returns null for nonexistent agent", async () => {
    const ctx = makeToolCtx();
    const result = await agentGetTool.execute({ agentId: "nonexistent" }, ctx);
    expect(result).toBeNull();
  });

  it("returns agent with identity files", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    const id = await agentCreateTool.execute({
      name: "GetMe",
      model: "ollama/llama3.2",
      soul: "My soul",
    }, ctx);
    const result = await agentGetTool.execute({ agentId: id as string }, ctx) as {
      agent: AgentDefinition;
      soul: string;
    };
    expect(result.agent.name).toBe("GetMe");
    expect(result.soul).toContain("My soul");
  });
});
