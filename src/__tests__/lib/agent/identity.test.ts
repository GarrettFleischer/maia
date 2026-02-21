import { describe, it, expect, beforeEach } from "bun:test";
import { getAgentIdentity, listAgents, setAgentStatus } from "@/lib/agent/identity";
import { makeTestContext } from "../../helpers/fakes";
import { FakeFs } from "../../helpers/fakes";
import type { AppContext } from "@/lib/context";
import path from "path";

const AGENTS_DIR = path.join(process.cwd(), "data", "agents");

function seedAgent(ctx: AppContext, id: string, name = "Test Agent", model = "ollama/llama3.2", status = "active") {
  const now = new Date().toISOString();
  ctx.db.prepare(
    "INSERT INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, name, model, status, now, now);
}

function seedIdentityFiles(fs: FakeFs, agentId: string) {
  const dir = path.join(AGENTS_DIR, agentId);
  fs.seed(path.join(dir, "SOUL.md"), "# Soul\nI am a helpful agent.");
  fs.seed(path.join(dir, "MEMORY.md"), "# Memory\nNo memories yet.");
  fs.seed(path.join(dir, "GOALS.md"), "# Goals\n- Be helpful");
  fs.seed(path.join(dir, "USER.md"), "# User\nThe user is a developer.");
}

describe("getAgentIdentity", () => {
  let ctx: AppContext;
  let fs: FakeFs;

  beforeEach(() => {
    fs = new FakeFs();
    ctx = makeTestContext({ fs });
  });

  it("returns null when agent does not exist", () => {
    expect(getAgentIdentity(ctx, "nonexistent")).toBeNull();
  });

  it("returns null for deleted agents", () => {
    seedAgent(ctx, "agent-1", "Test", "ollama/llama3.2", "deleted");
    expect(getAgentIdentity(ctx, "agent-1")).toBeNull();
  });

  it("returns agent with identity files", () => {
    seedAgent(ctx, "agent-1");
    seedIdentityFiles(fs, "agent-1");
    const result = getAgentIdentity(ctx, "agent-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("agent-1");
    expect(result!.name).toBe("Test Agent");
    expect(result!.soul).toContain("# Soul");
    expect(result!.memory).toContain("# Memory");
    expect(result!.goals).toContain("# Goals");
    expect(result!.user).toContain("# User");
  });

  it("returns empty strings for missing identity files (graceful fallback)", () => {
    seedAgent(ctx, "agent-2");
    // No identity files seeded
    const result = getAgentIdentity(ctx, "agent-2");
    expect(result).not.toBeNull();
    expect(result!.soul).toBe("");
    expect(result!.memory).toBe("");
  });

  it("includes all AgentDefinition fields", () => {
    seedAgent(ctx, "agent-3");
    const result = getAgentIdentity(ctx, "agent-3");
    expect(result!.model).toBe("ollama/llama3.2");
    expect(result!.status).toBe("active");
    expect(result!.createdAt).toBeDefined();
    expect(result!.updatedAt).toBeDefined();
  });
});

describe("listAgents", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("returns empty array when no agents", () => {
    expect(listAgents(ctx)).toEqual([]);
  });

  it("returns all non-deleted agents", () => {
    seedAgent(ctx, "a1", "Agent 1");
    seedAgent(ctx, "a2", "Agent 2");
    seedAgent(ctx, "a3", "Deleted", "ollama/llama3.2", "deleted");
    const agents = listAgents(ctx);
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.id)).toContain("a1");
    expect(agents.map((a) => a.id)).toContain("a2");
    expect(agents.map((a) => a.id)).not.toContain("a3");
  });

  it("returns agents in created_at order", () => {
    // Insert with slight delay using different timestamps
    ctx.db.prepare("INSERT INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("z", "Z", "ollama/llama3.2", "active", "2024-01-02T00:00:00Z", "2024-01-02T00:00:00Z");
    ctx.db.prepare("INSERT INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("a", "A", "ollama/llama3.2", "active", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z");
    const agents = listAgents(ctx);
    expect(agents[0].id).toBe("a");
    expect(agents[1].id).toBe("z");
  });
});

describe("setAgentStatus", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("updates agent status", () => {
    seedAgent(ctx, "agent-1");
    setAgentStatus(ctx, "agent-1", "running");
    const row = ctx.db.prepare("SELECT status FROM agents WHERE id = ?").get("agent-1") as { status: string };
    expect(row.status).toBe("running");
  });

  it("updates updated_at timestamp", () => {
    const before = new Date().toISOString();
    seedAgent(ctx, "agent-1");
    setAgentStatus(ctx, "agent-1", "paused");
    const row = ctx.db.prepare("SELECT updated_at FROM agents WHERE id = ?").get("agent-1") as { updated_at: string };
    expect(row.updated_at >= before).toBe(true);
  });
});
