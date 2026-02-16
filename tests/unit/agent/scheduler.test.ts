/**
 * @fileoverview Unit tests for scheduled tasks and reminders.
 * @module tests/unit/agent/scheduler
 */

import { describe, it, expect } from "bun:test";
import { createScheduler } from "../../../src/agent/scheduler.js";
import { inMemoryFileSystem, fixedClock } from "../../helpers/index.js";

describe("Scheduler", () => {
  function makeScheduler() {
    const fs = inMemoryFileSystem();
    const clock = fixedClock(new Date("2026-02-13T14:00:00.000Z"));
    const scheduler = createScheduler({
      fs,
      clock,
      schedulerPath: "/data/scheduler.json",
    });
    return { scheduler, fs, clock };
  }

  it("should add a one-shot task", async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.add({
      schedule: "2026-02-14T15:00:00.000Z",
      prompt: "Remind me about the meeting",
      channel: "discord",
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("pending");
    expect(task.prompt).toContain("meeting");
  });

  it("should add a recurring task with cron expression", async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.add({
      schedule: "0 9 * * 1",
      prompt: "Weekly standup summary",
      channel: "cli",
    });

    expect(task.id).toBeDefined();
    expect(task.schedule).toBe("0 9 * * 1");
  });

  it("should list all tasks", async () => {
    const { scheduler } = makeScheduler();
    await scheduler.add({ schedule: "2026-02-14T10:00:00Z", prompt: "Task 1", channel: "cli" });
    await scheduler.add({ schedule: "2026-02-15T10:00:00Z", prompt: "Task 2", channel: "cli" });

    const tasks = await scheduler.list();
    expect(tasks).toHaveLength(2);
  });

  it("should remove a task", async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.add({
      schedule: "2026-02-14T10:00:00Z",
      prompt: "To remove",
      channel: "cli",
    });

    await scheduler.remove(task.id);
    const tasks = await scheduler.list();
    expect(tasks).toHaveLength(0);
  });

  it("should find due tasks", async () => {
    const { scheduler } = makeScheduler();
    // Past time = due now
    await scheduler.add({
      schedule: "2026-02-13T13:00:00.000Z",
      prompt: "Overdue task",
      channel: "cli",
    });
    // Future time = not due
    await scheduler.add({
      schedule: "2026-02-14T15:00:00.000Z",
      prompt: "Future task",
      channel: "cli",
    });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].prompt).toContain("Overdue");
  });

  it("should persist tasks to disk", async () => {
    const { scheduler, fs } = makeScheduler();
    await scheduler.add({
      schedule: "2026-02-14T10:00:00Z",
      prompt: "Persistent task",
      channel: "cli",
    });

    const content = await fs.readFile("/data/scheduler.json");
    expect(content).toContain("Persistent task");
  });

  it("should mark completed one-shot tasks", async () => {
    const { scheduler } = makeScheduler();
    const task = await scheduler.add({
      schedule: "2026-02-13T13:00:00.000Z",
      prompt: "Complete me",
      channel: "cli",
    });

    await scheduler.markCompleted(task.id);
    const tasks = await scheduler.list();
    const completed = tasks.find((t) => t.id === task.id);
    expect(completed?.status).toBe("completed");
  });

  it("should normalize object schedule to string on load (cron)", async () => {
    const fs = inMemoryFileSystem();
    const clock = fixedClock(new Date("2026-02-13T09:00:00.000Z")); // 09:00 so "0 9 * * *" matches
    const schedulerPath = "/data/scheduler.json";
    const raw = [
      {
        id: "c2240360ae7ce9d5abc604f5d2a32506",
        schedule: { cron: "0 9 * * *" },
        prompt: "Legacy task",
        channel: "agent:test",
        status: "pending",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ];
    await fs.mkdir("/data");
    await fs.writeFile(schedulerPath, JSON.stringify(raw, null, 2));

    const scheduler = createScheduler({ fs, clock, schedulerPath });
    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].schedule).toBe("0 9 * * *");
    expect(due[0].prompt).toBe("Legacy task");
  });

  it("should drop task with object schedule when no string can be extracted", async () => {
    const fs = inMemoryFileSystem();
    const clock = fixedClock(new Date("2026-02-13T14:00:00.000Z"));
    const schedulerPath = "/data/scheduler.json";
    const raw = [
      {
        id: "bad-task-id",
        schedule: { type: "custom", config: {} },
        prompt: "Invalid",
        channel: "cli",
        status: "pending",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ];
    await fs.mkdir("/data");
    await fs.writeFile(schedulerPath, JSON.stringify(raw, null, 2));

    const scheduler = createScheduler({ fs, clock, schedulerPath });
    const list = await scheduler.list();
    expect(list).toHaveLength(0);
    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(0);
  });
});
