/**
 * @fileoverview Unit tests for scheduler cron matching, deduplication, and polling.
 * @module tests/unit/agent/scheduler-polling
 *
 * @note The existing scheduler.test.ts covers add/remove/list/getDueTasks for ISO
 * timestamps. This file covers cron expressions, the polling start/stop loop,
 * markCompleted behaviour differences (ISO vs cron), and agentId on tasks.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createScheduler } from "../../../src/agent/scheduler.js";
import type { Scheduler, TaskDueHandler } from "../../../src/agent/scheduler.js";
import { inMemoryFileSystem, capturingLogger, fixedClock } from "../../helpers/index.js";

// ─── Helpers ─────────────────────────────────────────────────────

function makeScheduler(date?: Date) {
  const fs = inMemoryFileSystem();
  const logger = capturingLogger();
  const clock = fixedClock(date ?? new Date("2026-02-13T09:00:00.000Z"));
  const scheduler = createScheduler({
    fs,
    clock,
    schedulerPath: "/data/scheduler.json",
    logger,
    checkIntervalMs: 100, // Fast for testing
  });
  return { scheduler, fs, clock, logger };
}

// ─── cronMatchesNow (tested via getDueTasks) ─────────────────────

describe("Scheduler cron matching", () => {
  it("should match cron '0 9 * * *' at 09:00", async () => {
    const { scheduler } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    await scheduler.add({ schedule: "0 9 * * *", prompt: "Morning task", channel: "cli" });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].prompt).toBe("Morning task");
  });

  it("should not match cron '0 9 * * *' at 10:00", async () => {
    const { scheduler } = makeScheduler(new Date("2026-02-13T10:00:00.000Z"));
    await scheduler.add({ schedule: "0 9 * * *", prompt: "Morning task", channel: "cli" });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(0);
  });

  it("should match cron '*/5 * * * *' at minute 0, 5, 10", async () => {
    const { scheduler: s0 } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    await s0.add({ schedule: "*/5 * * * *", prompt: "Every 5min", channel: "cli" });
    expect(await s0.getDueTasks()).toHaveLength(1);

    const { scheduler: s5 } = makeScheduler(new Date("2026-02-13T09:05:00.000Z"));
    await s5.add({ schedule: "*/5 * * * *", prompt: "Every 5min", channel: "cli" });
    expect(await s5.getDueTasks()).toHaveLength(1);

    const { scheduler: s3 } = makeScheduler(new Date("2026-02-13T09:03:00.000Z"));
    await s3.add({ schedule: "*/5 * * * *", prompt: "Every 5min", channel: "cli" });
    expect(await s3.getDueTasks()).toHaveLength(0);
  });

  it("should match cron with day-of-week filter", async () => {
    // 2026-02-13 is a Friday (day 5)
    const { scheduler } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    await scheduler.add({ schedule: "0 9 * * 5", prompt: "Friday task", channel: "cli" });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(1);
  });

  it("should skip invalid cron (3 parts)", async () => {
    const { scheduler } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    await scheduler.add({ schedule: "0 9 *", prompt: "Bad cron", channel: "cli" });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(0);
  });

  it("should skip cron with NaN field", async () => {
    const { scheduler } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    await scheduler.add({ schedule: "abc 9 * * *", prompt: "NaN field", channel: "cli" });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(0);
  });
});

// ─── Cron deduplication ──────────────────────────────────────────

describe("Scheduler cron deduplication", () => {
  it("should not return task with lastRunAt in the same minute", async () => {
    const { scheduler } = makeScheduler(new Date("2026-02-13T09:00:30.000Z"));
    const task = await scheduler.add({ schedule: "0 9 * * *", prompt: "Already ran", channel: "cli" });

    // Simulate it having already run this minute
    await scheduler.markCompleted(task.id);

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(0);
  });

  it("should return task with lastRunAt in a different minute", async () => {
    const fs = inMemoryFileSystem();
    const logger = capturingLogger();

    // First run at 09:00
    const clock1 = fixedClock(new Date("2026-02-13T09:00:00.000Z"));
    const s1 = createScheduler({ fs, clock: clock1, schedulerPath: "/data/scheduler.json", logger });
    const task = await s1.add({ schedule: "*/1 * * * *", prompt: "Frequent", channel: "cli" });
    await s1.markCompleted(task.id);

    // Next check at 09:01 - should be due again
    const clock2 = fixedClock(new Date("2026-02-13T09:01:00.000Z"));
    const s2 = createScheduler({ fs, clock: clock2, schedulerPath: "/data/scheduler.json", logger });
    const due = await s2.getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].prompt).toBe("Frequent");
  });
});

// ─── markCompleted ───────────────────────────────────────────────

describe("Scheduler markCompleted", () => {
  it("should mark ISO task as 'completed'", async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.add({
      schedule: "2026-02-13T08:00:00.000Z", // In the past
      prompt: "One-shot",
      channel: "cli",
    });

    await scheduler.markCompleted(task.id);

    const all = await scheduler.list();
    const updated = all.find((t) => t.id === task.id);
    expect(updated!.status).toBe("completed");
  });

  it("should keep cron task as 'pending' (only update lastRunAt)", async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.add({
      schedule: "0 9 * * *",
      prompt: "Recurring",
      channel: "cli",
    });

    await scheduler.markCompleted(task.id);

    const all = await scheduler.list();
    const updated = all.find((t) => t.id === task.id);
    expect(updated!.status).toBe("pending");
    expect(updated!.lastRunAt).toBeDefined();
  });
});

// ─── start / stop ────────────────────────────────────────────────

describe("Scheduler start/stop", () => {
  let scheduler: Scheduler;

  afterEach(() => {
    // Ensure we always clean up intervals
    scheduler?.stop();
  });

  it("should call handler for due tasks immediately on start", async () => {
    const { scheduler: s } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    scheduler = s;
    await scheduler.add({ schedule: "0 9 * * *", prompt: "Run me", channel: "cli" });

    const handled: string[] = [];
    scheduler.start(async (task) => { handled.push(task.prompt); });

    // Give the immediate tick time to run
    await new Promise((r) => setTimeout(r, 50));

    expect(handled).toContain("Run me");
  });

  it("should be idempotent (calling start twice does not create duplicate intervals)", async () => {
    const { scheduler: s } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    scheduler = s;

    let callCount = 0;
    const handler: TaskDueHandler = async () => { callCount++; };

    scheduler.start(handler);
    scheduler.start(handler); // Should not create a second interval

    await new Promise((r) => setTimeout(r, 250));
    // If duplicated, count would be significantly higher
    // With 100ms interval, ~2-3 ticks in 250ms. If duplicated, ~4-6.
    expect(callCount).toBeLessThanOrEqual(4);
  });

  it("should stop and not call handler after stop()", async () => {
    const { scheduler: s } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    scheduler = s;
    await scheduler.add({ schedule: "0 9 * * *", prompt: "Check", channel: "cli" });

    let callCount = 0;
    scheduler.start(async () => { callCount++; });
    await new Promise((r) => setTimeout(r, 50));
    scheduler.stop();

    const afterStop = callCount;
    await new Promise((r) => setTimeout(r, 200));
    // Should not have increased (maybe +1 race from an in-flight tick)
    expect(callCount).toBeLessThanOrEqual(afterStop + 1);
  });

  it("should not throw when stop is called without starting", () => {
    const { scheduler: s } = makeScheduler();
    scheduler = s;
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("should log and continue when handler throws", async () => {
    const { scheduler: s, logger } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    scheduler = s;
    await scheduler.add({ schedule: "0 9 * * *", prompt: "Fail", channel: "cli" });

    scheduler.start(async () => { throw new Error("Handler boom"); });
    await new Promise((r) => setTimeout(r, 50));

    expect(logger.calls.some((c) => c.level === "warn")).toBe(true);
  });
});

// ─── agentId on tasks ────────────────────────────────────────────

describe("Scheduler agentId", () => {
  it("should store agentId on added task", async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.add({
      schedule: "0 9 * * *",
      prompt: "Agent task",
      channel: "cli",
      agentId: "research-bot",
    });

    const all = await scheduler.list();
    const found = all.find((t) => t.id === task.id);
    expect((found as unknown as Record<string, unknown>).agentId).toBe("research-bot");
  });

  it("should return agentId on due tasks", async () => {
    const { scheduler } = makeScheduler(new Date("2026-02-13T09:00:00.000Z"));
    await scheduler.add({
      schedule: "0 9 * * *",
      prompt: "Agent task",
      channel: "cli",
      agentId: "research-bot",
    });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(1);
    expect((due[0] as unknown as Record<string, unknown>).agentId).toBe("research-bot");
  });
});
