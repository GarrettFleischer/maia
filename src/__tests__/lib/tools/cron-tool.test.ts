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
      taskDescription: "Monday morning check-in",
    }, ctx);
    expect(typeof id).toBe("string");
    expect((id as string).length).toBeGreaterThan(0);
  });

  it("persists the job in the database", async () => {
    const ctx = makeToolCtx();
    await cronScheduleTool.execute({ expression: "*/5 * * * *", taskDescription: "Every 5 minutes" }, ctx);
    const rows = ctx.db.prepare("SELECT * FROM cron_jobs").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].expression).toBe("*/5 * * * *");
    expect(rows[0].task_description).toBe("Every 5 minutes");
    expect(rows[0].agent_id).toBe("maia");
  });

  it("generates unique IDs for each job", async () => {
    const ctx = makeToolCtx();
    const id1 = await cronScheduleTool.execute({ expression: "0 * * * *", taskDescription: "Hourly" }, ctx);
    const id2 = await cronScheduleTool.execute({ expression: "0 * * * *", taskDescription: "Hourly 2" }, ctx);
    expect(id1).not.toBe(id2);
  });
});

describe("cronListTool", () => {
  it("returns empty list when no jobs", async () => {
    const ctx = makeToolCtx();
    const result = await cronListTool.execute({}, ctx);
    expect(result).toEqual([]);
  });

  it("returns all scheduled jobs", async () => {
    const ctx = makeToolCtx();
    await cronScheduleTool.execute({ expression: "0 9 * * *", taskDescription: "Daily" }, ctx);
    await cronScheduleTool.execute({ expression: "0 18 * * *", taskDescription: "Evening" }, ctx);
    const result = await cronListTool.execute({}, ctx) as CronJob[];
    expect(result).toHaveLength(2);
    expect(result[0].expression).toBeDefined();
    expect(result[0].taskDescription).toBeDefined();
    expect(result[0].isBuiltIn).toBe(false);
  });
});

describe("cronDeleteTool", () => {
  it("deletes a non-built-in job", async () => {
    const ctx = makeToolCtx();
    const id = await cronScheduleTool.execute({ expression: "0 * * * *", taskDescription: "Delete me" }, ctx);
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
    // Insert a built-in job
    const id = "builtin-heartbeat";
    const now = new Date().toISOString();
    ctx.db.prepare(
      "INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, "0 * * * *", "Heartbeat", "maia", 1, now);
    await expect(cronDeleteTool.execute({ jobId: id }, ctx)).rejects.toThrow("Cannot delete built-in");
  });
});
