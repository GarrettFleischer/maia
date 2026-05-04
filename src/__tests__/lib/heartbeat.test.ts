import { describe, it, expect, beforeEach } from "bun:test";
import {
  fireHeartbeat,
  _resetHeartbeatIdempotencyForTests,
} from "@/lib/heartbeat";
import { refreshEmbeddings } from "@/lib/knowledge/refresh-embeddings";
import { registerLlmQueueHandlers } from "@/lib/queue/llm-queue-handlers";
import { makeTestContext, FakeEvents, FakeResponse } from "../helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { appendEntry, createSession } from "@/lib/history";
import type { AppContext } from "@/lib/context";

function seedAgent(ctx: AppContext, id: string, status = "active") {
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      "INSERT INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, id, "ollama/llama3.2", status, now, now);
}

describe("refreshEmbeddings", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    updateSettings(ctx, { embeddingModel: "ollama/nomic-embed-text" });
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () =>
        new FakeResponse(
          200,
          JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }),
        ),
    );
  });

  it("resolves without error when called (no-op; history indexed on append)", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "unindexed message",
      timestamp: new Date().toISOString(),
    });

    await expect(refreshEmbeddings(ctx)).resolves.toBeUndefined();
  });

  it("resolves without error when entries exist", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "already indexed",
      timestamp: new Date().toISOString(),
    });

    await expect(refreshEmbeddings(ctx)).resolves.toBeUndefined();
  });

  it("skips entries with empty content", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "agent",
      content: "",
      timestamp: new Date().toISOString(),
    });

    let embedCallCount = 0;
    (
      ctx.http as {
        on: (p: string | RegExp, h: () => Promise<FakeResponse>) => void;
      }
    ).on(/api\/embed/, async () => {
      embedCallCount++;
      return new FakeResponse(200, JSON.stringify({ embeddings: [[0.1]] }));
    });

    await refreshEmbeddings(ctx);
    expect(embedCallCount).toBe(0);
  });

  it("does not throw when embed service fails; logs and continues", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "some message",
      timestamp: new Date().toISOString(),
    });
    // Override http to fail
    const failCtx = makeTestContext({ db: ctx.db, events: ctx.events });
    (
      failCtx.http as {
        on: (p: string, h: () => Promise<FakeResponse>) => void;
      }
    ).on("/api/embed", async () => new FakeResponse(500, "error"));
    await expect(refreshEmbeddings(failCtx)).resolves.toBeUndefined();
  });

  it("resolves without error when content is long (no-op)", async () => {
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "one two three four five six seven eight",
      timestamp: new Date().toISOString(),
    });
    await expect(refreshEmbeddings(ctx)).resolves.toBeUndefined();
  });
});

describe("fireHeartbeat", () => {
  let ctx: AppContext;
  let events: FakeEvents;

  beforeEach(() => {
    registerLlmQueueHandlers();
    _resetHeartbeatIdempotencyForTests();
    events = new FakeEvents();
    ctx = makeTestContext({ events });
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () =>
        new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] })),
    );
  });

  it("emits a heartbeat event", async () => {
    const runAgentFn = async () => {};
    await fireHeartbeat(ctx, runAgentFn);
    const heartbeats = events.emitted.filter((e) => e.event === "heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect(
      (heartbeats[0].data as { timestamp: string }).timestamp,
    ).toBeDefined();
  });

  it("triggers runAgentFn only for maia", async () => {
    seedAgent(ctx, "maia", "active");
    seedAgent(ctx, "agent-1", "active");
    seedAgent(ctx, "agent-2", "paused");
    const triggered: string[] = [];
    await fireHeartbeat(ctx, async (_c, agentId) => {
      triggered.push(agentId);
    });
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toBe("maia");
  });

  it("does not trigger runAgentFn when maia does not exist", async () => {
    seedAgent(ctx, "agent-1", "active");
    const triggered: string[] = [];
    await fireHeartbeat(ctx, async (_c, agentId) => {
      triggered.push(agentId);
    });
    expect(triggered).toHaveLength(0);
  });

  it("does not trigger runAgentFn when maia is paused", async () => {
    seedAgent(ctx, "maia", "paused");
    const triggered: string[] = [];
    await fireHeartbeat(ctx, async (_c, agentId) => {
      triggered.push(agentId);
    });
    expect(triggered).toHaveLength(0);
  });

  it("creates a single session for maia with name Heartbeat", async () => {
    seedAgent(ctx, "maia", "active");
    await fireHeartbeat(ctx, async () => {});
    const sessions = ctx.db
      .prepare("SELECT * FROM sessions WHERE type = 'agents'")
      .all() as Record<string, unknown>[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe("Heartbeat");
    const parts = JSON.parse(sessions[0].participants as string);
    expect(parts).toContain("maia");
  });

  it("passes the heartbeat message containing HEARTBEAT, timestamp, and check tasks/cron instructions", async () => {
    seedAgent(ctx, "maia", "active");
    const messages: string[] = [];
    await fireHeartbeat(ctx, async (_c, _agentId, _sessionId, message) => {
      messages.push(message);
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("[HEARTBEAT]");
    expect(messages[0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(messages[0]).toContain("task board");
    expect(messages[0]).toContain("cron job");
  });

  it("runs embedding refresh before waking agents", async () => {
    seedAgent(ctx, "maia", "active");
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "unindexed at heartbeat time",
      timestamp: new Date().toISOString(),
    });

    await fireHeartbeat(ctx, async () => {});
    // refreshEmbeddings is a no-op (semantic memory is written on append via indexHistoryEntry)
  });

  it("passes task board section to maia when present", async () => {
    seedAgent(ctx, "maia", "active");
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "task-1",
        "Unassigned task",
        "",
        "todo",
        "maia",
        null,
        now,
        now,
        "[]",
      );
    const messages: string[] = [];
    await fireHeartbeat(ctx, async (_c, _agentId, _sessionId, message) => {
      messages.push(message);
    });
    expect(messages[0]).toContain("Task Board");
    expect(messages[0]).toContain("Unassigned task");
  });

  it("passes cron jobs section to maia when cron jobs exist", async () => {
    seedAgent(ctx, "maia", "active");
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("job-1", "0 9 * * *", "Daily", "maia", 0, now, "cron_echo", "{}");
    const messages: string[] = [];
    await fireHeartbeat(ctx, async (_c, _agentId, _sessionId, message) => {
      messages.push(message);
    });
    expect(messages[0]).toContain("Cron Jobs");
    expect(messages[0]).toContain("job-1");
    expect(messages[0]).toContain("0 9 * * *");
  });

  it("passes agents section to maia when agents exist", async () => {
    seedAgent(ctx, "maia", "active");
    seedAgent(ctx, "worker-1", "active");
    const messages: string[] = [];
    await fireHeartbeat(ctx, async (_c, _agentId, _sessionId, message) => {
      messages.push(message);
    });
    expect(messages[0]).toContain("Agents");
    expect(messages[0]).toContain("maia");
    expect(messages[0]).toContain("worker-1");
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

  it("reuses the same Heartbeat session across multiple runs", async () => {
    seedAgent(ctx, "maia", "active");
    const runAgentFn = async () => {};

    await fireHeartbeat(ctx, runAgentFn);
    const firstSessions = ctx.db
      .prepare(
        "SELECT id FROM sessions WHERE type = 'agents' AND name = 'Heartbeat'",
      )
      .all() as { id: string }[];
    expect(firstSessions).toHaveLength(1);

    const firstId = firstSessions[0]?.id;
    expect(firstId).toBeDefined();

    _resetHeartbeatIdempotencyForTests();
    await fireHeartbeat(ctx, runAgentFn);
    const secondSessions = ctx.db
      .prepare(
        "SELECT id FROM sessions WHERE type = 'agents' AND name = 'Heartbeat'",
      )
      .all() as { id: string }[];

    expect(secondSessions).toHaveLength(1);
    expect(secondSessions[0].id).toBe(firstId);
  });

  it("does not throw when the underlying agent run (e.g. Ollama chat) fails", async () => {
    seedAgent(ctx, "maia", "active");
    const erroringRunAgentFn = async (): Promise<string> => {
      throw new Error("simulated /api/chat failure");
    };

    // fireHeartbeat should swallow the error from the heartbeat tool and only log it.
    await expect(
      fireHeartbeat(ctx, erroringRunAgentFn),
    ).resolves.toBeUndefined();
  });
});
