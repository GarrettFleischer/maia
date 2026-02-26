import { describe, it, expect, beforeEach } from "bun:test";
import { fireHeartbeat, _resetHeartbeatIdempotencyForTests } from "@/lib/heartbeat";
import { refreshEmbeddings } from "@/lib/knowledge/refresh-embeddings";
import { _clearOllamaEmbedContextLengthCacheForTests } from "@/lib/knowledge/embedding";
import { makeTestContext, FakeEvents, FakeResponse } from "../helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { appendEntry, createSession } from "@/lib/history";
import { createVectorStore } from "@/lib/knowledge/vector-store";
import type { AppContext } from "@/lib/context";

function seedAgent(ctx: AppContext, id: string, status = "active") {
  const now = new Date().toISOString();
  ctx.db.prepare(
    "INSERT INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, id, "ollama/llama3.2", status, now, now);
}

describe("refreshEmbeddings", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    updateSettings(ctx, { embeddingModel: "nomic-embed-text" });
    (ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }))
    );
  });

  it("indexes history entries that have no vector yet", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    const entry = appendEntry(ctx, sessionId, { role: "user", content: "unindexed message", timestamp: new Date().toISOString() });

    const store = createVectorStore(ctx.db);
    const beforeCount = (ctx.db.prepare("SELECT COUNT(*) as c FROM history_vectors").get() as { c: number }).c;
    expect(beforeCount).toBe(0);

    await refreshEmbeddings(ctx);

    const afterCount = (ctx.db.prepare("SELECT COUNT(*) as c FROM history_vectors WHERE entry_id = ?").get(entry.id) as { c: number }).c;
    expect(afterCount).toBe(1);
  });

  it("does not re-index history entries that already have a vector", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    const entry = appendEntry(ctx, sessionId, { role: "user", content: "already indexed", timestamp: new Date().toISOString() });
    // Manually insert a vector for this entry
    const store = createVectorStore(ctx.db);
    store.insertHistory("vec-1", sessionId, entry.id, "already indexed", [0.1, 0.2], false, new Date().toISOString());

    let embedCallCount = 0;
    (ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => {
        embedCallCount++;
        return new FakeResponse(200, JSON.stringify({ embeddings: [[0.5, 0.5]] }));
      }
    );

    await refreshEmbeddings(ctx);

    // Should not have called embed again for an already-indexed entry
    expect(embedCallCount).toBe(0);
  });

  it("skips entries with empty content", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, { role: "agent", content: "", timestamp: new Date().toISOString() });

    let embedCallCount = 0;
    (ctx.http as { on: (p: string | RegExp, h: () => Promise<FakeResponse>) => void }).on(
      /api\/embed/,
      async () => {
        embedCallCount++;
        return new FakeResponse(200, JSON.stringify({ embeddings: [[0.1]] }));
      }
    );

    await refreshEmbeddings(ctx);
    expect(embedCallCount).toBe(0);
  });

  it("does not throw when embed service fails; logs and continues", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, { role: "user", content: "some message", timestamp: new Date().toISOString() });
    // Override http to fail
    const failCtx = makeTestContext({ db: ctx.db, events: ctx.events });
    (failCtx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => new FakeResponse(500, "error")
    );
    await expect(refreshEmbeddings(failCtx)).resolves.toBeUndefined();
  });
});

describe("fireHeartbeat", () => {
  let ctx: AppContext;
  let events: FakeEvents;

  beforeEach(() => {
    _resetHeartbeatIdempotencyForTests();
    events = new FakeEvents();
    ctx = makeTestContext({ events });
    (ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] }))
    );
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

  it("runs embedding refresh before waking agents (vectors available when runAgentFn is called)", async () => {
    seedAgent(ctx, "maia", "active");
    const sessionId = createSession(ctx, ["user", "maia"]);
    const entry = appendEntry(ctx, sessionId, {
      role: "user",
      content: "unindexed at heartbeat time",
      timestamp: new Date().toISOString(),
    });

    let vectorCountWhenAgentRan = -1;
    await fireHeartbeat(ctx, async () => {
      vectorCountWhenAgentRan = (
        ctx.db
          .prepare("SELECT COUNT(*) as c FROM history_vectors WHERE entry_id = ?")
          .get(entry.id) as { c: number }
      ).c;
    });
    // The entry should already be indexed by the time the agent runs
    expect(vectorCountWhenAgentRan).toBe(1);
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

  it("skips running the heartbeat tool when called again within 60s (idempotency)", async () => {
    seedAgent(ctx, "maia", "active");
    const runAgentCalls: number[] = [];
    const runAgentFn = async () => {
      runAgentCalls.push(1);
    };
    await fireHeartbeat(ctx, runAgentFn);
    expect(runAgentCalls).toHaveLength(1);
    await fireHeartbeat(ctx, runAgentFn);
    // Second call within 60s should skip the tool execution, so runAgentFn is not called again
    expect(runAgentCalls).toHaveLength(1);
  });
});
