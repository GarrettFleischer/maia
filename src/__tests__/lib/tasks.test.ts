/**
 * @fileoverview Tests for the task domain module in `src/lib/tasks.ts`.
 * Verifies task lifecycle behavior (create, list, get, update with notes, delete)
 * and that the `tasks_changed` event is emitted on write operations.
 * @module __tests__/lib/tasks
 *
 * @example
 * // See createTask and updateTask expectations around defaults and notes.
 */

import { describe, it, expect, spyOn } from "bun:test";
import type { AppContext } from "@/lib/context";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import {
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
} from "@/lib/tasks";

/**
 * @brief Creates an AppContext backed by an in-memory DB for task tests.
 * @returns Fresh AppContext suitable for task domain testing.
 */
function makeContext(): AppContext {
  return makeTestContext();
}

describe("tasks domain", () => {
  it("creates a task with defaults and emits tasks_changed", () => {
    const ctx = makeContext();
    const emitSpy = spyOn(ctx.events, "emit");

    const task = createTask(ctx, {
      title: "Test task",
      description: "details",
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("todo");
    expect(task.createdBy).toBe("user");
    expect(task.assignedTo).toBeNull();
    expect(task.notes).toEqual([]);

    const listed = listTasks(ctx);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(task.id);

    expect(emitSpy).toHaveBeenCalledWith({
      event: "tasks_changed",
      data: {},
    });
  });

  it("respects filters when listing tasks", () => {
    const ctx = makeContext();

    const a = createTask(ctx, {
      title: "A",
      createdBy: "alice",
      assignedTo: "alice",
    });
    const b = createTask(ctx, {
      title: "B",
      createdBy: "bob",
      assignedTo: "bob",
    });

    const byAlice = listTasks(ctx, { createdBy: "alice" });
    expect(byAlice.map((t) => t.id)).toEqual([a.id]);

    const assignedToBob = listTasks(ctx, { assignedTo: "bob" });
    expect(assignedToBob.map((t) => t.id)).toEqual([b.id]);
  });

  it("returns null when getting a missing task", () => {
    const ctx = makeContext();
    const found = getTask(ctx, "does-not-exist");
    expect(found).toBeNull();
  });

  it("updates status, appends notes with default and custom agentId, and emits tasks_changed", () => {
    const ctx = makeContext();
    const emitSpy = spyOn(ctx.events, "emit");
    const created = createTask(ctx, { title: "With notes" });

    const first = updateTask(ctx, created.id, {
      status: "in_progress",
      note: "Started work",
    });
    expect(first).not.toBeNull();
    expect(first?.status).toBe("in_progress");
    expect(first?.notes).toHaveLength(1);
    expect(first?.notes?.[0].agentId).toBe("user");

    const second = updateTask(ctx, created.id, {
      status: "done",
      note: "Completed",
      noteAgentId: "agent-123",
      assignedTo: "agent-123",
    });

    expect(second).not.toBeNull();
    expect(second?.status).toBe("done");
    expect(second?.assignedTo).toBe("agent-123");
    expect(second?.notes).toHaveLength(2);
    expect(second?.notes?.[1]).toEqual(
      expect.objectContaining({
        agentId: "agent-123",
        content: "Completed",
      }),
    );

    expect(emitSpy).toHaveBeenCalledWith({
      event: "tasks_changed",
      data: {},
    });
  });

  it("returns null when updating a missing task", () => {
    const ctx = makeContext();
    const updated = updateTask(ctx, "missing", { status: "done" });
    expect(updated).toBeNull();
  });

  it("deletes existing tasks, emits tasks_changed, and returns false for missing tasks", () => {
    const ctx = makeContext();
    const emitSpy = spyOn(ctx.events, "emit");
    const created = createTask(ctx, { title: "To delete" });

    const deleted = deleteTask(ctx, created.id);
    expect(deleted).toBe(true);
    const afterDelete = listTasks(ctx);
    expect(afterDelete).toHaveLength(0);

    expect(emitSpy).toHaveBeenCalledWith({
      event: "tasks_changed",
      data: {},
    });

    const deletedAgain = deleteTask(ctx, created.id);
    expect(deletedAgain).toBe(false);
  });
});
