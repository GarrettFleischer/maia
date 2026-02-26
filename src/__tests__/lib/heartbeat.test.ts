import { describe, it, expect, beforeEach } from "bun:test";
import { fireHeartbeat } from "@/lib/heartbeat";
import { makeTestContext, FakeEvents } from "../helpers/fakes";
import type { AppContext } from "@/lib/context";

function seedAgent(ctx: AppContext, id: string, status = "active") {
  const now = new Date().toISOString();
  ctx.db.prepare(
    "INSERT INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, id, "ollama/llama3.2", status, now, now);
}

describe("fireHeartbeat", () => {
  let ctx: AppContext;
  let events: FakeEvents;

  beforeEach(() => {
    events = new FakeEvents();
    ctx = makeTestContext({ events });
  });

  it("emits a heartbeat event", async () => {
    const runAgentFn = async () => {};
    await fireHeartbeat(ctx, runAgentFn);
    const heartbeats = events.emitted.filter((e) => e.event === "heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect((heartbeats[0].data as { timestamp: string }).timestamp).toBeDefined();
  });

  it("triggers runAgentFn only for maia", async () => {
    seedAgent(ctx, "maia", "active");
    seedAgent(ctx, "agent-1", "active");
    seedAgent(ctx, "agent-2", "paused");
    const triggered: string[] = [];
    await fireHeartbeat(ctx, async (_c, agentId) => { triggered.push(agentId); });
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toBe("maia");
  });

  it("does not trigger runAgentFn when maia does not exist", async () => {
    seedAgent(ctx, "agent-1", "active");
    const triggered: string[] = [];
    await fireHeartbeat(ctx, async (_c, agentId) => { triggered.push(agentId); });
    expect(triggered).toHaveLength(0);
  });

  it("does not trigger runAgentFn when maia is paused", async () => {
    seedAgent(ctx, "maia", "paused");
    const triggered: string[] = [];
    await fireHeartbeat(ctx, async (_c, agentId) => { triggered.push(agentId); });
    expect(triggered).toHaveLength(0);
  });

  it("creates a single session for maia", async () => {
    seedAgent(ctx, "maia", "active");
    await fireHeartbeat(ctx, async () => {});
    const sessions = ctx.db
      .prepare("SELECT * FROM sessions WHERE type = 'agents'")
      .all() as Record<string, unknown>[];
    expect(sessions).toHaveLength(1);
    const parts = JSON.parse(sessions[0].participants as string);
    expect(parts).toContain("maia");
  });

  it("passes the heartbeat message containing HEARTBEAT and timestamp to maia", async () => {
    seedAgent(ctx, "maia", "active");
    const messages: string[] = [];
    await fireHeartbeat(ctx, async (_c, _agentId, _sessionId, message) => {
      messages.push(message);
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("[HEARTBEAT]");
    expect(messages[0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("passes task board section to maia when present", async () => {
    seedAgent(ctx, "maia", "active");
    const now = new Date().toISOString();
    ctx.db.prepare(
      "INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("task-1", "Unassigned task", "", "todo", "maia", null, now, now, "[]");
    const messages: string[] = [];
    await fireHeartbeat(ctx, async (_c, _agentId, _sessionId, message) => {
      messages.push(message);
    });
    expect(messages[0]).toContain("Task Board");
    expect(messages[0]).toContain("Unassigned task");
  });
});
