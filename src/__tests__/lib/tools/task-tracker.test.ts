/**
 * @fileoverview Tests for task_list tool: default exclude completed, and filter by column/agent.
 * @module __tests__/lib/tools/task-tracker.test
 */
import { describe, it, expect } from "bun:test";
import { taskCreateTool, taskListTool, taskUpdateTool } from "@/lib/tools/task-tracker";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";

function makeToolCtx(): ToolContext {
  const ctx = makeTestContext();
  return {
    ...ctx,
    agentId: "agent-a",
    sessionId: "session-1",
    volumeRoot: "/workspace",
  };
}

describe("task_list", () => {
  it("excludes completed (done) tasks when no filters given", async () => {
    const ctx = makeToolCtx();
    await taskCreateTool.execute({ title: "Todo one" }, ctx);
    const inProgress = await taskCreateTool.execute({ title: "In progress one" }, ctx) as { id: string };
    await taskUpdateTool.execute({ taskId: inProgress.id, status: "in_progress" }, ctx);
    const doneTask = await taskCreateTool.execute({ title: "Done one" }, ctx) as { id: string };
    await taskUpdateTool.execute({ taskId: doneTask.id, status: "done" }, ctx);

    const result = await taskListTool.execute({}, ctx) as { id: string; status: string }[];
    expect(result.length).toBe(2);
    expect(result.every((t) => t.status !== "done")).toBe(true);
    expect(result.map((t) => t.status).sort()).toEqual(["in_progress", "todo"]);
  });

  it("returns only done tasks when status is 'done'", async () => {
    const ctx = makeToolCtx();
    await taskCreateTool.execute({ title: "Todo" }, ctx);
    const doneId = (await taskCreateTool.execute({ title: "Done" }, ctx) as { id: string }).id;
    await taskUpdateTool.execute({ taskId: doneId, status: "done" }, ctx);

    const result = await taskListTool.execute({ status: "done" }, ctx) as { id: string; status: string }[];
    expect(result.length).toBe(1);
    expect(result[0].status).toBe("done");
  });

  it("filters by status (column) when provided", async () => {
    const ctx = makeToolCtx();
    await taskCreateTool.execute({ title: "T1" }, ctx);
    await taskCreateTool.execute({ title: "T2" }, ctx);

    const todoList = await taskListTool.execute({ status: "todo" }, ctx) as { status: string }[];
    expect(todoList.length).toBe(2);
    expect(todoList.every((t) => t.status === "todo")).toBe(true);
  });

  it("filters by assignedTo (agent id)", async () => {
    const ctx = makeToolCtx();
    await taskCreateTool.execute({ title: "Unassigned" }, ctx);
    await taskCreateTool.execute({ title: "Mine", assignedTo: "agent-a" }, ctx);

    const result = await taskListTool.execute({ assignedTo: "agent-a" }, ctx) as { title: string }[];
    expect(result.length).toBe(1);
    expect(result[0].title).toBe("Mine");
  });

  it("filters by createdBy (agent id)", async () => {
    const ctx = makeToolCtx();
    await taskCreateTool.execute({ title: "By me" }, ctx);

    const result = await taskListTool.execute({ createdBy: "agent-a" }, ctx) as { title: string }[];
    expect(result.length).toBe(1);
    expect(result[0].title).toBe("By me");
  });
});
