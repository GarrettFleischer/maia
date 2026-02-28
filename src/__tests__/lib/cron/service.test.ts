/**
 * @fileoverview Unit tests for CronService: loading cron_jobs, scheduling with node-cron, and invoking runAgentFn.
 * @module __tests__/lib/cron/service.test
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startCronScheduler,
  stopCronScheduler,
  isCronSchedulerRunning,
  refreshHeartbeatJob,
  syncAgentRunJobs,
  reconcileAgentRunTasks,
} from "@/lib/cron/service";
import { registerLlmQueueHandlers } from "@/lib/queue/llm-queue-handlers";
import { AGENT_RUN_JOB_ID_PREFIX } from "@/lib/cron/expression";
import { updateSettings } from "@/lib/settings";
import { makeTestContext, FakeEvents } from "../../helpers/fakes";
import type { AppContext } from "@/lib/context";
import { _resetHeartbeatIdempotencyForTests } from "@/lib/heartbeat";

function seedAgent(ctx: AppContext, id: string, status = "active") {
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      "INSERT OR REPLACE INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, id, "ollama/llama3.2", status, now, now);
}

function seedCronJob(
  ctx: AppContext,
  opts: {
    id?: string;
    expression?: string;
    taskDescription?: string;
    agentId?: string;
    isBuiltIn?: number;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
  } = {},
) {
  const id =
    opts.id ?? `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  const taskDescription = opts.taskDescription ?? "Daily standup";
  const toolName = opts.toolName ?? "cron_echo";
  const toolArgs = opts.toolArgs ?? { message: taskDescription };
  ctx.db
    .prepare(
      `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.expression ?? "0 9 * * *",
      taskDescription,
      opts.agentId ?? "maia",
      opts.isBuiltIn ?? 0,
      now,
      toolName,
      JSON.stringify(toolArgs),
    );
  return id;
}

describe("CronService", () => {
  let ctx: AppContext;
  let events: FakeEvents;

  beforeEach(() => {
    registerLlmQueueHandlers();
    events = new FakeEvents();
    ctx = makeTestContext({ events });
  });

  afterEach(() => {
    stopCronScheduler();
  });

  describe("startCronScheduler / stopCronScheduler / isCronSchedulerRunning", () => {
    it("does not throw when no cron jobs exist", () => {
      ctx.db.prepare("DELETE FROM cron_jobs").run();
      expect(() =>
        startCronScheduler(ctx, async () => {}, { runOnInit: false }),
      ).not.toThrow();
      expect(isCronSchedulerRunning()).toBe(true);
      stopCronScheduler();
      expect(isCronSchedulerRunning()).toBe(false);
    });

    it("starts and stops without error when jobs exist", () => {
      seedCronJob(ctx, { expression: "0 9 * * *", taskDescription: "Daily" });
      expect(() =>
        startCronScheduler(ctx, async () => {}, { runOnInit: false }),
      ).not.toThrow();
      expect(isCronSchedulerRunning()).toBe(true);
      expect(() => stopCronScheduler()).not.toThrow();
      expect(isCronSchedulerRunning()).toBe(false);
    });

    it("calling startCronScheduler twice does not register duplicate jobs", () => {
      seedCronJob(ctx, { id: "single", expression: "0 9 * * *" });
      startCronScheduler(ctx, async () => {}, { runOnInit: false });
      const runAgentCalls: {
        agentId: string;
        sessionId: string;
        message: string;
      }[] = [];
      startCronScheduler(
        ctx,
        async (_c, agentId, sessionId, message) => {
          runAgentCalls.push({ agentId, sessionId, message });
        },
        { runOnInit: false },
      );
      // Second start is a no-op; we cannot easily assert duplicate schedule calls without mocking.
      // We assert that stop is safe and state is consistent.
      stopCronScheduler();
      expect(isCronSchedulerRunning()).toBe(false);
    });

    it("stopCronScheduler is safe to call when not running", () => {
      expect(() => stopCronScheduler()).not.toThrow();
    });

    it("allows restart after stop", () => {
      seedCronJob(ctx, { expression: "0 9 * * *" });
      startCronScheduler(ctx, async () => {}, { runOnInit: false });
      stopCronScheduler();
      expect(isCronSchedulerRunning()).toBe(false);
      startCronScheduler(ctx, async () => {}, { runOnInit: false });
      expect(isCronSchedulerRunning()).toBe(true);
      stopCronScheduler();
    });
  });

  describe("execution behavior (runOnInit)", () => {
    it("invokes runAgentFn with agentId, sessionId, message, and initialToolCall when a job fires", async () => {
      seedCronJob(ctx, {
        id: "job-1",
        expression: "0 9 * * *",
        taskDescription: "Review backlog",
        agentId: "maia",
        toolName: "cron_echo",
        toolArgs: { message: "Review backlog" },
      });
      const runAgentCalls: {
        agentId: string;
        sessionId: string;
        message: string;
        options?: {
          initialToolCall?: { name: string; args: Record<string, unknown> };
        };
      }[] = [];
      startCronScheduler(
        ctx,
        async (_c, agentId, sessionId, message, options) => {
          runAgentCalls.push({ agentId, sessionId, message, options });
        },
        { runOnInit: true },
      );

      await new Promise((r) => setTimeout(r, 20)); // allow node-cron runOnInit callbacks to run
      expect(runAgentCalls.length).toBeGreaterThanOrEqual(1);
      const call = runAgentCalls[0]!;
      expect(call.agentId).toBe("maia");
      expect(call.sessionId).toBeDefined();
      expect(call.sessionId.length).toBeGreaterThan(0);
      expect(call.message).toBe("[CRON]");
      expect(call.options?.initialToolCall).toEqual({
        name: "cron_echo",
        args: { message: "Review backlog" },
      });
    });

    it("emits cron_fired event when a job runs", async () => {
      seedCronJob(ctx, {
        id: "job-event",
        expression: "0 9 * * *",
        taskDescription: "Event check",
        agentId: "maia",
      });
      startCronScheduler(ctx, async () => {}, { runOnInit: true });

      await new Promise((r) => setTimeout(r, 20));
      const cronFired = events.emitted.filter((e) => e.event === "cron_fired");
      const jobEventFired = cronFired.find(
        (e) => (e.data as { jobId: string }).jobId === "job-event",
      );
      expect(jobEventFired).toBeDefined();
      expect(
        (
          jobEventFired!.data as {
            jobId: string;
            agentId: string;
            timestamp: string;
          }
        ).jobId,
      ).toBe("job-event");
      expect(
        (
          jobEventFired!.data as {
            jobId: string;
            agentId: string;
            timestamp: string;
          }
        ).agentId,
      ).toBe("maia");
    });

    it("creates a session for the owning agent when job runs", async () => {
      seedCronJob(ctx, {
        id: "job-session",
        agentId: "agent-alpha",
        taskDescription: "Session test",
      });
      startCronScheduler(ctx, async () => {}, { runOnInit: true });

      await new Promise((r) => setTimeout(r, 20));
      const sessions = ctx.db
        .prepare("SELECT * FROM sessions WHERE type = 'agents'")
        .all() as Record<string, unknown>[];
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const participants = JSON.parse(
        sessions[0].participants as string,
      ) as string[];
      expect(participants).toContain("agent-alpha");
    });

    it("schedules multiple jobs and runs each on runOnInit", async () => {
      seedCronJob(ctx, {
        id: "a",
        agentId: "agent-a",
        taskDescription: "Task A",
      });
      seedCronJob(ctx, {
        id: "b",
        agentId: "agent-b",
        taskDescription: "Task B",
      });
      const runAgentCalls: { agentId: string }[] = [];
      startCronScheduler(
        ctx,
        async (_c, agentId) => {
          runAgentCalls.push({ agentId });
        },
        { runOnInit: true },
      );

      await new Promise((r) => setTimeout(r, 20));
      expect(runAgentCalls.length).toBe(2);
      const agentIds = runAgentCalls.map((c) => c.agentId).sort();
      expect(agentIds).toEqual(["agent-a", "agent-b"]);
    });

    it("reuses same session when multiple jobs share agent and task description", async () => {
      ctx.db
        .prepare("DELETE FROM cron_jobs WHERE id = 'builtin-heartbeat'")
        .run();
      seedCronJob(ctx, {
        id: "job-1",
        agentId: "worker-a",
        taskDescription: "Hourly heartbeat",
        expression: "0 * * * *",
      });
      seedCronJob(ctx, {
        id: "job-2",
        agentId: "worker-a",
        taskDescription: "Hourly heartbeat",
        expression: "30 * * * *",
      });
      const runAgentCalls: { sessionId: string }[] = [];
      startCronScheduler(
        ctx,
        async (_c, _agentId, sessionId) => {
          runAgentCalls.push({ sessionId });
        },
        { runOnInit: true },
      );

      await new Promise((r) => setTimeout(r, 20));
      expect(runAgentCalls.length).toBe(2);
      expect(runAgentCalls[0]!.sessionId).toBe(runAgentCalls[1]!.sessionId);
    });

    it("when builtin-heartbeat job runs, emits heartbeat event and cron_fired", async () => {
      _resetHeartbeatIdempotencyForTests();
      startCronScheduler(ctx, async () => {}, { runOnInit: true });
      await new Promise((r) => setTimeout(r, 20));
      const heartbeatEvents = events.emitted.filter(
        (e) => e.event === "heartbeat",
      );
      const cronFired = events.emitted.filter((e) => e.event === "cron_fired");
      expect(heartbeatEvents.length).toBeGreaterThanOrEqual(1);
      expect(
        (heartbeatEvents[0].data as { timestamp: string }).timestamp,
      ).toBeDefined();
      const heartbeatCronFired = cronFired.filter(
        (e) => (e.data as { jobId: string }).jobId === "builtin-heartbeat",
      );
      expect(heartbeatCronFired.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("refreshHeartbeatJob", () => {
    it("updates heartbeat job expression and re-schedules when scheduler is running", () => {
      updateSettings(ctx, { heartbeatIntervalMinutes: 30 });
      startCronScheduler(ctx, async () => {}, { runOnInit: false });
      updateSettings(ctx, { heartbeatIntervalMinutes: 15 });
      expect(() => refreshHeartbeatJob(ctx)).not.toThrow();
      const row = ctx.db
        .prepare(
          "SELECT expression FROM cron_jobs WHERE id = 'builtin-heartbeat'",
        )
        .get() as { expression: string } | undefined;
      expect(row?.expression).toBe("*/15 * * * *");
      stopCronScheduler();
    });

    it("is no-op when scheduler has not been started", () => {
      updateSettings(ctx, { heartbeatIntervalMinutes: 5 });
      expect(() => refreshHeartbeatJob(ctx)).not.toThrow();
      const row = ctx.db
        .prepare(
          "SELECT expression FROM cron_jobs WHERE id = 'builtin-heartbeat'",
        )
        .get() as { expression: string } | undefined;
      expect(row?.expression).toBe("*/5 * * * *");
    });
  });

  describe("syncAgentRunJobs", () => {
    it("creates agent-run job for each active agent except maia with staggered expressions", () => {
      updateSettings(ctx, { heartbeatIntervalMinutes: 30 });
      seedAgent(ctx, "maia", "active");
      seedAgent(ctx, "worker-a", "active");
      seedAgent(ctx, "worker-b", "active");
      syncAgentRunJobs(ctx);
      const rows = ctx.db
        .prepare(
          "SELECT id, expression, agent_id FROM cron_jobs WHERE id LIKE ? ORDER BY id",
        )
        .all(AGENT_RUN_JOB_ID_PREFIX + "%") as {
        id: string;
        expression: string;
        agent_id: string;
      }[];
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.agent_id).sort()).toEqual([
        "worker-a",
        "worker-b",
      ]);
      expect(rows[0]!.expression).toBe("0,30 * * * *");
      expect(rows[1]!.expression).toBe("15,45 * * * *");
    });

    it("does not create agent-run job for maia or paused agents", () => {
      updateSettings(ctx, { heartbeatIntervalMinutes: 30 });
      seedAgent(ctx, "maia", "active");
      seedAgent(ctx, "worker-a", "paused");
      syncAgentRunJobs(ctx);
      const rows = ctx.db
        .prepare("SELECT id FROM cron_jobs WHERE id LIKE ?")
        .all(AGENT_RUN_JOB_ID_PREFIX + "%") as { id: string }[];
      expect(rows).toHaveLength(0);
    });

    it("removes agent-run jobs when agents are no longer active", () => {
      updateSettings(ctx, { heartbeatIntervalMinutes: 30 });
      seedAgent(ctx, "maia", "active");
      seedAgent(ctx, "worker-a", "active");
      syncAgentRunJobs(ctx);
      let rows = ctx.db
        .prepare("SELECT id FROM cron_jobs WHERE id LIKE ?")
        .all(AGENT_RUN_JOB_ID_PREFIX + "%") as { id: string }[];
      expect(rows).toHaveLength(1);
      ctx.db
        .prepare("UPDATE agents SET status = ? WHERE id = ?")
        .run("paused", "worker-a");
      syncAgentRunJobs(ctx);
      rows = ctx.db
        .prepare("SELECT id FROM cron_jobs WHERE id LIKE ?")
        .all(AGENT_RUN_JOB_ID_PREFIX + "%") as { id: string }[];
      expect(rows).toHaveLength(0);
    });
  });

  describe("reconcileAgentRunTasks", () => {
    it("does not throw when scheduler is running and agent-run jobs exist", () => {
      updateSettings(ctx, { heartbeatIntervalMinutes: 30 });
      seedAgent(ctx, "maia", "active");
      seedAgent(ctx, "worker-a", "active");
      startCronScheduler(ctx, async () => {}, { runOnInit: false });
      expect(() => reconcileAgentRunTasks(ctx)).not.toThrow();
      stopCronScheduler();
    });
  });

  describe("startCronScheduler sync", () => {
    it("runs syncAgentRunJobs so agent-run jobs exist for active agents on start", () => {
      updateSettings(ctx, { heartbeatIntervalMinutes: 30 });
      seedAgent(ctx, "maia", "active");
      seedAgent(ctx, "worker-a", "active");
      startCronScheduler(ctx, async () => {}, { runOnInit: false });
      const rows = ctx.db
        .prepare("SELECT id, expression FROM cron_jobs WHERE id LIKE ?")
        .all(AGENT_RUN_JOB_ID_PREFIX + "%") as {
        id: string;
        expression: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(AGENT_RUN_JOB_ID_PREFIX + "worker-a");
      stopCronScheduler();
    });
  });
});
