import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { fireHeartbeat, startHeartbeatScheduler, stopHeartbeatScheduler } from "@/lib/heartbeat";
import { makeTestContext, FakeEvents } from "../helpers/fakes";
import { updateSettings } from "@/lib/settings";
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

  afterEach(() => {
    stopHeartbeatScheduler();
  });

  it("emits a heartbeat event", async () => {
    const runAgentFn = async () => {};
    await fireHeartbeat(ctx, runAgentFn);
    const heartbeats = events.emitted.filter((e) => e.event === "heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect((heartbeats[0].data as { timestamp: string }).timestamp).toBeDefined();
  });

  it("triggers runAgentFn for each active agent", async () => {
    seedAgent(ctx, "agent-1", "active");
    seedAgent(ctx, "agent-2", "active");
    seedAgent(ctx, "agent-3", "paused");
    const triggered: string[] = [];
    await fireHeartbeat(ctx, async (_c, agentId) => { triggered.push(agentId); });
    expect(triggered).toContain("agent-1");
    expect(triggered).toContain("agent-2");
    expect(triggered).not.toContain("agent-3");
  });

  it("does not trigger runAgentFn when no active agents", async () => {
    seedAgent(ctx, "agent-1", "paused");
    const triggered: string[] = [];
    await fireHeartbeat(ctx, async (_c, agentId) => { triggered.push(agentId); });
    expect(triggered).toHaveLength(0);
  });

  it("creates a new session per active agent", async () => {
    seedAgent(ctx, "agent-1", "active");
    await fireHeartbeat(ctx, async () => {});
    const sessions = ctx.db
      .prepare("SELECT * FROM sessions WHERE type = 'agents'")
      .all() as Record<string, unknown>[];
    expect(sessions).toHaveLength(1);
    const parts = JSON.parse(sessions[0].participants as string);
    expect(parts).toContain("agent-1");
  });

  it("passes the heartbeat message containing HEARTBEAT and timestamp", async () => {
    seedAgent(ctx, "agent-1", "active");
    const messages: string[] = [];
    await fireHeartbeat(ctx, async (_c, _agentId, _sessionId, message) => {
      messages.push(message);
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("[HEARTBEAT]");
    // Contains a timestamp
    expect(messages[0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("startHeartbeatScheduler / stopHeartbeatScheduler", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    stopHeartbeatScheduler(); // Ensure clean state
  });

  afterEach(() => {
    stopHeartbeatScheduler();
  });

  it("can be started and stopped without error", () => {
    updateSettings(ctx, { heartbeatIntervalMinutes: 1 });
    expect(() => startHeartbeatScheduler(ctx, async () => {})).not.toThrow();
    expect(() => stopHeartbeatScheduler()).not.toThrow();
  });

  it("does not start a second scheduler if already running", () => {
    updateSettings(ctx, { heartbeatIntervalMinutes: 60 });
    startHeartbeatScheduler(ctx, async () => {});
    // Second call should be a no-op
    expect(() => startHeartbeatScheduler(ctx, async () => {})).not.toThrow();
    stopHeartbeatScheduler();
  });

  it("stopHeartbeatScheduler is safe to call when not running", () => {
    expect(() => stopHeartbeatScheduler()).not.toThrow();
  });
});
