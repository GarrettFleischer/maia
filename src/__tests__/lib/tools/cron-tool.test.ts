import { describe, it, expect } from "bun:test";
import {
  cronScheduleTool,
  cronListTool,
  cronDeleteTool,
} from "@/lib/tools/cron-tool";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import type { CronJob } from "@/lib/types";
import { getSettings } from "@/lib/settings";

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
  it("creates a cron job with prompt_wake and returns its id", async () => {
    const ctx = makeToolCtx();
    const id = await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 9 * * 1",
        prompt_wake: true,
        desc: "Monday morning check-in",
      },
      ctx,
    );
    expect(typeof id).toBe("string");
    expect((id as string).length).toBeGreaterThan(0);
  });

  it("persists prompt wake with cron_message and cron_echo row shape", async () => {
    const ctx = makeToolCtx();
    ctx.db
      .prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'")
      .run();
    await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "*/5 * * * *",
        cron_message: "Check the board every five minutes.",
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
    expect(rows[0].tool_name).toBe("cron_echo");
    expect(JSON.parse(rows[0].tool_args as string)).toEqual({});
    expect(String(rows[0].cron_message)).toContain("board");
  });

  it("throws when neither prompt_wake, cron_message, nor persona_id is given", async () => {
    const ctx = makeToolCtx();
    await expect(
      cronScheduleTool.execute(
        {
          id: "maia",
          expr: "0 * * * *",
        },
        ctx,
      ),
    ).rejects.toThrow("Set prompt_wake");
  });

  it("throws when target agent is not maia", async () => {
    const ctx = makeToolCtx();
    const whitelistedModel = getSettings(ctx).whitelistedModels[0];
    expect(whitelistedModel).toBeDefined();
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "INSERT OR IGNORE INTO agents (id, name, model, system_prompt_extra, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("worker", "Worker", whitelistedModel!, null, "active", now, now);
    await expect(
      cronScheduleTool.execute(
        {
          id: "worker",
          expr: "0 * * * *",
          prompt_wake: true,
        },
        ctx,
      ),
    ).rejects.toThrow(/maia/i);
  });

  it("throws when maia agent is missing from the database", async () => {
    const ctx = makeToolCtx();
    ctx.db.prepare("DELETE FROM agents WHERE id = 'maia'").run();
    await expect(
      cronScheduleTool.execute(
        {
          id: "maia",
          expr: "0 * * * *",
          prompt_wake: true,
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
        prompt_wake: true,
      },
      ctx,
    );
    const id2 = await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 * * * *",
        cron_message: "Second job",
      },
      ctx,
    );
    expect(id1).not.toBe(id2);
  });

  it("stores persona wake metadata with default task-review message", async () => {
    const ctx = makeToolCtx();
    const whitelistedModel = getSettings(ctx).whitelistedModels[0];
    expect(whitelistedModel).toBeDefined();
    ctx.db
      .prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'")
      .run();
    await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 10 * * *",
        persona_id: "typescript-pro",
        persona_model: whitelistedModel,
        desc: "Delegated sweep",
      },
      ctx,
    );
    const rows = ctx.db
      .prepare(
        "SELECT persona_id, persona_model, cron_message FROM cron_jobs WHERE id != 'builtin-heartbeat'",
      )
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].persona_id).toBe("typescript-pro");
    expect(rows[0].persona_model).toBe(whitelistedModel);
    expect(String(rows[0].cron_message).toLowerCase()).toContain("task_list");
  });

  it("stores prompt_wake with default cron message", async () => {
    const ctx = makeToolCtx();
    ctx.db
      .prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'")
      .run();
    await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 11 * * *",
        prompt_wake: true,
        desc: "Board hygiene",
      },
      ctx,
    );
    const rows = ctx.db
      .prepare(
        "SELECT persona_id, cron_message FROM cron_jobs WHERE id != 'builtin-heartbeat'",
      )
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].persona_id).toBeNull();
    expect(String(rows[0].cron_message).toLowerCase()).toContain("task_list");
  });

  it("throws when persona_id targets non-maia agent", async () => {
    const ctx = makeToolCtx();
    const whitelistedModel = getSettings(ctx).whitelistedModels[0];
    expect(whitelistedModel).toBeDefined();
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "INSERT OR IGNORE INTO agents (id, name, model, system_prompt_extra, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("worker", "Worker", whitelistedModel!, null, "active", now, now);
    await expect(
      cronScheduleTool.execute(
        {
          id: "worker",
          expr: "0 * * * *",
          persona_id: "typescript-pro",
          persona_model: whitelistedModel,
        },
        ctx,
      ),
    ).rejects.toThrow(/maia/i);
  });
});

describe("cronListTool", () => {
  it("returns empty list when no jobs", async () => {
    const ctx = makeToolCtx();
    ctx.db.prepare("DELETE FROM cron_jobs").run();
    const result = await cronListTool.execute({}, ctx);
    expect(result).toEqual([]);
  });

  it("returns scheduled jobs with cron_message", async () => {
    const ctx = makeToolCtx();
    ctx.db
      .prepare("DELETE FROM cron_jobs WHERE id != 'builtin-heartbeat'")
      .run();
    await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 9 * * *",
        cron_message: "Daily",
      },
      ctx,
    );
    await cronScheduleTool.execute(
      {
        id: "maia",
        expr: "0 18 * * *",
        cron_message: "Evening",
      },
      ctx,
    );
    const result = (await cronListTool.execute({}, ctx)) as CronJob[];
    expect(result.length).toBeGreaterThanOrEqual(2);
    const userJobs = result.filter((j) => !j.isBuiltIn);
    expect(userJobs).toHaveLength(2);
    const daily = userJobs.find((j) => j.cronMessage === "Daily");
    expect(daily).toBeDefined();
    expect(daily!.expression).toBeDefined();
    expect(daily!.taskDescription).toBeDefined();
    expect(daily!.toolName).toBe("cron_echo");
    expect(daily!.toolArgs).toEqual({});
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
        prompt_wake: true,
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
        cron_message: "Delete me",
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

  it("rejects deleting a built-in job", async () => {
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
    await expect(
      cronDeleteTool.execute({ id: "builtin-heartbeat" }, ctx),
    ).rejects.toThrow(/built-in/i);
  });
});
