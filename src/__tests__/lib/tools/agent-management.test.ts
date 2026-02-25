import { describe, it, expect, beforeEach } from "bun:test";
import {
  agentCreateTool,
  agentDeleteTool,
  agentListTool,
  agentGetTool,
  agentUpdateIdentityTool,
} from "@/lib/tools/agent-management";
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

describe("agentUpdateIdentityTool", () => {
  it("updates the current agent's MEMORY.md", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    const path = await import("path");
    const { getAgentsDir } = await import("@/lib/data-dir");
    const agentDir = path.join(getAgentsDir(), "maia");
    await agentUpdateIdentityTool.execute(
      { file: "memory", content: "# Memory\n\n- User prefers TDD.\n" },
      ctx,
    );
    expect(fs.snapshot()[path.join(agentDir, "MEMORY.md")]).toBe("# Memory\n\n- User prefers TDD.\n");
  });

  it("updates SOUL.md when file is soul", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    const path = await import("path");
    const { getAgentsDir } = await import("@/lib/data-dir");
    const agentDir = path.join(getAgentsDir(), "maia");
    await agentUpdateIdentityTool.execute({ file: "soul", content: "# Soul\n\nI am Maia.\n" }, ctx);
    expect(fs.snapshot()[path.join(agentDir, "SOUL.md")]).toBe("# Soul\n\nI am Maia.\n");
  });

  it("updates GOALS.md and USER.md", async () => {
    const fs = new FakeFs();
    const ctx = makeToolCtx(fs);
    const path = await import("path");
    const { getAgentsDir } = await import("@/lib/data-dir");
    const agentDir = path.join(getAgentsDir(), "maia");
    await agentUpdateIdentityTool.execute(
      { file: "goals", content: "# Goals\n\n- [ ] Task one\n" },
      ctx,
    );
    await agentUpdateIdentityTool.execute(
      { file: "user", content: "# User\n\nThe user is a developer.\n" },
      ctx,
    );
    expect(fs.snapshot()[path.join(agentDir, "GOALS.md")]).toBe("# Goals\n\n- [ ] Task one\n");
    expect(fs.snapshot()[path.join(agentDir, "USER.md")]).toBe("# User\n\nThe user is a developer.\n");
  });
});
