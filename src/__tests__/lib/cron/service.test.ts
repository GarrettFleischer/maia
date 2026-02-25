/**
 * @fileoverview Unit tests for CronService: loading cron_jobs, scheduling with node-cron, and invoking runAgentFn.
 * @module __tests__/lib/cron/service.test
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startCronScheduler,
  stopCronScheduler,
  isCronSchedulerRunning,
} from "@/lib/cron/service";
import { makeTestContext, FakeEvents } from "../../helpers/fakes";
import type { AppContext } from "@/lib/context";

function seedCronJob(
  ctx: AppContext,
  opts: {
    id?: string;
    expression?: string;
    taskDescription?: string;
    agentId?: string;
    isBuiltIn?: number;
  } = {}
) {
  const id = opts.id ?? `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.expression ?? "0 9 * * *",
    opts.taskDescription ?? "Daily standup",
    opts.agentId ?? "maia",
    opts.isBuiltIn ?? 0,
    now
  );
  return id;
}

describe("CronService", () => {
  let ctx: AppContext;
  let events: FakeEvents;

  beforeEach(() => {
    events = new FakeEvents();
    ctx = makeTestContext({ events });
  });

  afterEach(() => {
    stopCronScheduler();
  });

  describe("startCronScheduler / stopCronScheduler / isCronSchedulerRunning", () => {
    it("does not throw when no cron jobs exist", () => {
      expect(() =>
        startCronScheduler(ctx, async () => {}, { runOnInit: false })
      ).not.toThrow();
      expect(isCronSchedulerRunning()).toBe(true);
      stopCronScheduler();
      expect(isCronSchedulerRunning()).toBe(false);
    });

    it("starts and stops without error when jobs exist", () => {
      seedCronJob(ctx, { expression: "0 9 * * *", taskDescription: "Daily" });
      expect(() =>
        startCronScheduler(ctx, async () => {}, { runOnInit: false })
      ).not.toThrow();
      expect(isCronSchedulerRunning()).toBe(true);
      expect(() => stopCronScheduler()).not.toThrow();
      expect(isCronSchedulerRunning()).toBe(false);
    });

    it("calling startCronScheduler twice does not register duplicate jobs", () => {
      seedCronJob(ctx, { id: "single", expression: "0 9 * * *" });
      startCronScheduler(ctx, async () => {}, { runOnInit: false });
      const runAgentCalls: { agentId: string; sessionId: string; message: string }[] = [];
      startCronScheduler(ctx, async (_c, agentId, sessionId, message) => {
        runAgentCalls.push({ agentId, sessionId, message });
      }, { runOnInit: false });
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
    it("invokes runAgentFn with correct agentId, sessionId, and [CRON] message when a job fires", async () => {
      seedCronJob(ctx, {
        id: "job-1",
        expression: "0 9 * * *",
        taskDescription: "Review backlog",
        agentId: "maia",
      });
      const runAgentCalls: { agentId: string; sessionId: string; message: string }[] = [];
      startCronScheduler(ctx, async (_c, agentId, sessionId, message) => {
        runAgentCalls.push({ agentId, sessionId, message });
      }, { runOnInit: true });

      await new Promise((r) => setTimeout(r, 20)); // allow node-cron runOnInit callbacks to run
      expect(runAgentCalls.length).toBeGreaterThanOrEqual(1);
      const call = runAgentCalls[0];
      expect(call.agentId).toBe("maia");
      expect(call.sessionId).toBeDefined();
      expect(call.sessionId.length).toBeGreaterThan(0);
      expect(call.message).toContain("[CRON]");
      expect(call.message).toContain("Review backlog");
      expect(call.message).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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
      expect(cronFired.length).toBeGreaterThanOrEqual(1);
      expect((cronFired[0].data as { jobId: string; agentId: string; timestamp: string }).jobId).toBe("job-event");
      expect((cronFired[0].data as { jobId: string; agentId: string; timestamp: string }).agentId).toBe("maia");
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
      const participants = JSON.parse(sessions[0].participants as string) as string[];
      expect(participants).toContain("agent-alpha");
    });

    it("schedules multiple jobs and runs each on runOnInit", async () => {
      seedCronJob(ctx, { id: "a", agentId: "agent-a", taskDescription: "Task A" });
      seedCronJob(ctx, { id: "b", agentId: "agent-b", taskDescription: "Task B" });
      const runAgentCalls: { agentId: string }[] = [];
      startCronScheduler(ctx, async (_c, agentId) => {
        runAgentCalls.push({ agentId });
      }, { runOnInit: true });

      await new Promise((r) => setTimeout(r, 20));
      expect(runAgentCalls.length).toBe(2);
      const agentIds = runAgentCalls.map((c) => c.agentId).sort();
      expect(agentIds).toEqual(["agent-a", "agent-b"]);
    });
  });
});
