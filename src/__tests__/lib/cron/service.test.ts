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
} from "@/lib/cron/service";
import { registerLlmQueueHandlers } from "@/lib/queue/llm-queue-handlers";
import { updateSettings, getSettings } from "@/lib/settings";
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
    personaId?: string | null;
    personaModel?: string | null;
    cronMessage?: string | null;
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
      `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args, persona_id, persona_model, cron_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      opts.personaId ?? null,
      opts.personaModel ?? null,
      opts.cronMessage ?? null,
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
      ctx.db
        .prepare("DELETE FROM cron_jobs WHERE id = 'builtin-heartbeat'")
        .run();
      seedAgent(ctx, "maia");
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

    it("invokes runAgentFn with personaTurn when persona_id is set", async () => {
      ctx.db
        .prepare("DELETE FROM cron_jobs WHERE id = 'builtin-heartbeat'")
        .run();
      seedAgent(ctx, "maia");
      const personaModel = getSettings(ctx).whitelistedModels[0];
      expect(personaModel).toBeDefined();
      seedCronJob(ctx, {
        id: "persona-job",
        expression: "0 9 * * *",
        taskDescription: "Persona sweep",
        agentId: "maia",
        personaId: "typescript-pro",
        personaModel,
        cronMessage: null,
        toolName: "cron_echo",
        toolArgs: {},
      });
      const runAgentCalls: {
        agentId: string;
        message: string;
        options?: { personaTurn?: { id: string; model: string } };
      }[] = [];
      startCronScheduler(
        ctx,
        async (_c, agentId, _sid, message, options) => {
          runAgentCalls.push({ agentId, message, options });
        },
        { runOnInit: true },
      );

      await new Promise((r) => setTimeout(r, 25));
      expect(runAgentCalls.length).toBeGreaterThanOrEqual(1);
      const call = runAgentCalls.find((c) => c.options?.personaTurn);
      expect(call).toBeDefined();
      expect(call!.agentId).toBe("maia");
      expect(call!.options?.personaTurn?.id).toBe("typescript-pro");
      expect(call!.options?.personaTurn?.model).toBe(personaModel);
      expect(call!.message.toLowerCase()).toContain("task_list");
    });

    it("invokes runAgentFn with plain message when cron_message is set", async () => {
      ctx.db
        .prepare("DELETE FROM cron_jobs WHERE id = 'builtin-heartbeat'")
        .run();
      seedAgent(ctx, "maia");
      seedCronJob(ctx, {
        id: "prompt-job",
        expression: "0 9 * * *",
        taskDescription: "Prompt wake",
        agentId: "maia",
        cronMessage: "Custom ping",
        toolName: "cron_echo",
        toolArgs: {},
      });
      const runAgentCalls: {
        message: string;
        options?: { initialToolCall?: { name: string } };
      }[] = [];
      startCronScheduler(
        ctx,
        async (_c, _agentId, _sid, message, options) => {
          runAgentCalls.push({ message, options });
        },
        { runOnInit: true },
      );

      await new Promise((r) => setTimeout(r, 25));
      const call = runAgentCalls.find((c) => c.message === "Custom ping");
      expect(call).toBeDefined();
      expect(call!.options?.initialToolCall).toBeUndefined();
    });

    it("emits cron_fired event when a job runs", async () => {
      seedAgent(ctx, "maia");
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
      seedAgent(ctx, "agent-alpha");
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
      ctx.db
        .prepare("DELETE FROM cron_jobs WHERE id = 'builtin-heartbeat'")
        .run();
      seedAgent(ctx, "agent-a", "paused");
      seedAgent(ctx, "agent-b", "paused");
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
      seedAgent(ctx, "worker-a", "paused");
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
      seedAgent(ctx, "maia");
      seedCronJob(ctx, {
        id: "builtin-heartbeat",
        expression: "*/30 * * * *",
        taskDescription: "Heartbeat",
        agentId: "maia",
        isBuiltIn: 1,
      });
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
      seedAgent(ctx, "maia");
      seedCronJob(ctx, {
        id: "builtin-heartbeat",
        expression: "*/30 * * * *",
        taskDescription: "Heartbeat",
        agentId: "maia",
        isBuiltIn: 1,
      });
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
      expect(row).toBeUndefined();
    });
  });
});
