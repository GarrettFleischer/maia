import { describe, it, expect } from "bun:test";
import {
  cronScheduleTool,
  cronListTool,
  cronDeleteTool,
} from "@/lib/tools/cron-tool";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import type { CronJob } from "@/lib/types";

function makeToolCtx(): ToolContext {
  const ctx = makeTestContext();
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      "INSERT OR IGNORE INTO agents (id, name, model, system_prompt_extra, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("maia", "Maia", "ollama/llama3.2", null, "active", now, now);
  return {
    ...ctx,
    agentId: "maia",
    sessionId: "session-1",
    volumeRoot: "/workspace",
  };
}

describe("cronScheduleTool", () => {
  it("creates a cron job and returns its id", async () => {
    const ctx = makeToolCtx();
    const id = await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 9 * * 1",
        tool: "cron_echo",
        args: { msg: "Monday morning check-in" },
      },
      ctx,
    );
    expect(typeof id).toBe("string");
    expect((id as string).length).toBeGreaterThan(0);
  });

  it("persists the job in the database with tool_name and tool_args", async () => {
    const ctx = makeToolCtx();
    ctx.db
      .prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'")
      .run();
    await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "*/5 * * * *",
        tool: "web_search",
        args: { q: "test" },
        desc: "Every 5 minutes",
      },
      ctx,
    );
    const rows = ctx.db
      .prepare("SELECT * FROM cron_jobs WHERE id != 'builtin-heartbeat'")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].expression).toBe("*/5 * * * *");
    expect(rows[0].task_description).toBe("Every 5 minutes");
    expect(rows[0].agent_id).toBe("maia");
    expect(rows[0].tool_name).toBe("web_search");
    expect(JSON.parse(rows[0].tool_args as string)).toEqual({ q: "test" });
  });

  it("accepts args as JSON string and persists correctly", async () => {
    const ctx = makeToolCtx();
    ctx.db
      .prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'")
      .run();
    const id = await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 9 * * *",
        tool: "task_list",
        args: "{}",
        desc: "Daily task summary",
      },
      ctx,
    );
    expect(typeof id).toBe("string");
    const rows = ctx.db
      .prepare("SELECT * FROM cron_jobs WHERE id = ?")
      .all(id) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("task_list");
    expect(JSON.parse(rows[0].tool_args as string)).toEqual({});
  });

  it("throws when target agent does not exist", async () => {
    const ctx = makeToolCtx();
    await expect(
      cronScheduleTool.execute(
        {
          id: "nonexistent-agent",
          expr: "0 * * * *",
          tool: "cron_echo",
          args: {},
        },
        ctx,
      ),
    ).rejects.toThrow(/Target agent not found or deleted/);
  });

  it("generates unique IDs for each job", async () => {
    const ctx = makeToolCtx();
    const id1 = await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 * * * *",
        tool: "cron_echo",
        args: {},
      },
      ctx,
    );
    const id2 = await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 * * * *",
        tool: "cron_echo",
        args: {},
      },
      ctx,
    );
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
    ctx.db
      .prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'")
      .run();
    await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 9 * * *",
        tool: "cron_echo",
        args: { msg: "Daily" },
      },
      ctx,
    );
    await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 18 * * *",
        tool: "cron_echo",
        args: { msg: "Evening" },
      },
      ctx,
    );
    const result = (await cronListTool.execute({}, ctx)) as CronJob[];
    expect(result.length).toBeGreaterThanOrEqual(2);
    const userJobs = result.filter((j) => !j.isBuiltIn);
    expect(userJobs).toHaveLength(2);
    const daily = userJobs.find(
      (j) => (j.toolArgs as { msg?: string })?.msg === "Daily",
    );
    expect(daily).toBeDefined();
    expect(daily!.expression).toBeDefined();
    expect(daily!.taskDescription).toBeDefined();
    expect(daily!.toolName).toBe("cron_echo");
    expect(daily!.toolArgs).toEqual({ msg: "Daily" });
    expect(daily!.isBuiltIn).toBe(false);
  });
});

describe("cronDeleteTool", () => {
  it("returns explicit success payload (never null)", async () => {
    const ctx = makeToolCtx();
    const id = await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 * * * *",
        tool: "cron_echo",
        args: { msg: "Delete me" },
      },
      ctx,
    );
    const result = await cronDeleteTool.execute({ id: id as string }, ctx);
    expect(result).toEqual({ success: true, message: "Cron job deleted." });
  });

  it("deletes a non-built-in job", async () => {
    const ctx = makeToolCtx();
    const id = await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 * * * *",
        tool: "cron_echo",
        args: { msg: "Delete me" },
      },
      ctx,
    );
    await cronDeleteTool.execute({ id: id as string }, ctx);
    const rows = ctx.db
      .prepare("SELECT * FROM cron_jobs WHERE id = ?")
      .all(id) as Record<string, unknown>[];
    expect(rows).toHaveLength(0);
  });

  it("throws when job does not exist", async () => {
    const ctx = makeToolCtx();
    await expect(
      cronDeleteTool.execute({ id: "nonexistent-id" }, ctx),
    ).rejects.toThrow();
  });

  it("deletes a built-in job when requested", async () => {
    const ctx = makeToolCtx();
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "builtin-heartbeat",
        "*/30 * * * *",
        "Heartbeat",
        "maia",
        1,
        now,
        "cron_echo",
        "{}",
      );
    await cronDeleteTool.execute({ id: "builtin-heartbeat" }, ctx);
    const rows = ctx.db
      .prepare("SELECT * FROM cron_jobs WHERE id = ?")
      .all("builtin-heartbeat") as Record<string, unknown>[];
    expect(rows).toHaveLength(0);
  });
});
