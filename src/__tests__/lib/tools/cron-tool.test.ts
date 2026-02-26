import { describe, it, expect, beforeEach } from "bun:test";
import { cronScheduleTool, cronListTool, cronDeleteTool } from "@/lib/tools/cron-tool";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import type { CronJob } from "@/lib/types";

function makeToolCtx(): ToolContext {
  const ctx = makeTestContext();
  return { ...ctx, agentId: "maia", sessionId: "session-1", volumeRoot: "/workspace" };
}

describe("cronScheduleTool", () => {
  it("creates a cron job and returns its id", async () => {
    const ctx = makeToolCtx();
    const id = await cronScheduleTool.execute({
      expression: "0 9 * * 1",
      toolName: "cron_echo",
      toolArgs: { message: "Monday morning check-in" },
    }, ctx);
    expect(typeof id).toBe("string");
    expect((id as string).length).toBeGreaterThan(0);
  });

  it("persists the job in the database with tool_name and tool_args", async () => {
    const ctx = makeToolCtx();
    ctx.db.prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'").run();
    await cronScheduleTool.execute({
      expression: "*/5 * * * *",
      toolName: "web_search",
      toolArgs: { query: "test" },
      taskDescription: "Every 5 minutes",
    }, ctx);
    const rows = ctx.db.prepare("SELECT * FROM cron_jobs WHERE id != 'builtin-heartbeat'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].expression).toBe("*/5 * * * *");
    expect(rows[0].task_description).toBe("Every 5 minutes");
    expect(rows[0].agent_id).toBe("maia");
    expect(rows[0].tool_name).toBe("web_search");
    expect(JSON.parse(rows[0].tool_args as string)).toEqual({ query: "test" });
  });

  it("generates unique IDs for each job", async () => {
    const ctx = makeToolCtx();
    const id1 = await cronScheduleTool.execute({
      expression: "0 * * * *",
      toolName: "cron_echo",
      toolArgs: {},
    }, ctx);
    const id2 = await cronScheduleTool.execute({
      expression: "0 * * * *",
      toolName: "cron_echo",
      toolArgs: {},
    }, ctx);
    expect(id1).not.toBe(id2);
  });
});

describe("cronListTool", () => {
  it("returns empty list when no jobs", async () => {
    const ctx = makeToolCtx();
    ctx.db.prepare("DELETE FROM cron_jobs").run();
    const result = await cronListTool.execute({}, ctx);
    expect(result).toEqual([]);
  });

  it("returns all scheduled jobs with toolName and toolArgs", async () => {
    const ctx = makeToolCtx();
    ctx.db.prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'").run();
    await cronScheduleTool.execute({
      expression: "0 9 * * *",
      toolName: "cron_echo",
      toolArgs: { message: "Daily" },
    }, ctx);
    await cronScheduleTool.execute({
      expression: "0 18 * * *",
      toolName: "cron_echo",
      toolArgs: { message: "Evening" },
    }, ctx);
    const result = await cronListTool.execute({}, ctx) as CronJob[];
    expect(result.length).toBeGreaterThanOrEqual(2);
    const userJobs = result.filter((j) => !j.isBuiltIn);
    expect(userJobs).toHaveLength(2);
    const daily = userJobs.find((j) => (j.toolArgs as { message?: string })?.message === "Daily");
    expect(daily).toBeDefined();
    expect(daily!.expression).toBeDefined();
    expect(daily!.taskDescription).toBeDefined();
    expect(daily!.toolName).toBe("cron_echo");
    expect(daily!.toolArgs).toEqual({ message: "Daily" });
    expect(daily!.isBuiltIn).toBe(false);
  });
});

describe("cronDeleteTool", () => {
  it("deletes a non-built-in job", async () => {
    const ctx = makeToolCtx();
    const id = await cronScheduleTool.execute({
      expression: "0 * * * *",
      toolName: "cron_echo",
      toolArgs: { message: "Delete me" },
    }, ctx);
    await cronDeleteTool.execute({ jobId: id as string }, ctx);
    const rows = ctx.db.prepare("SELECT * FROM cron_jobs WHERE id = ?").all(id) as Record<string, unknown>[];
    expect(rows).toHaveLength(0);
  });

  it("throws when job does not exist", async () => {
    const ctx = makeToolCtx();
    await expect(cronDeleteTool.execute({ jobId: "nonexistent-id" }, ctx)).rejects.toThrow();
  });

  it("throws when job is built-in", async () => {
    const ctx = makeToolCtx();
    await expect(cronDeleteTool.execute({ jobId: "builtin-heartbeat" }, ctx)).rejects.toThrow("Cannot delete built-in");
  });
});
