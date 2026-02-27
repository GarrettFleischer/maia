/**
 * @fileoverview Tests for PATCH /api/cron/jobs/[id].
 * @module __tests__/app/api/cron/jobs/[id]/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { PATCH } from "@/app/api/cron/jobs/[id]/route";

describe("PATCH /api/cron/jobs/[id]", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns 404 when job does not exist", async () => {
    const req = new Request("http://x/api/cron/jobs/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskDescription: "Updated" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid cron expression", async () => {
    const ctx = makeTestContext();
    const now = new Date().toISOString();
    ctx.db.prepare(
      "INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("patch-job", "0 * * * *", "Hourly", "maia", 0, now, "cron_echo", "{}");
    _setTestContext(ctx);

    const req = new Request("http://x/api/cron/jobs/patch-job", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression: "not valid cron" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "patch-job" }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid cron/i);
  });

  it("updates job and returns 200 with scheduleDescription and nextRunAt", async () => {
    const ctx = makeTestContext();
    const now = new Date().toISOString();
    ctx.db.prepare(
      "INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("patch-job-2", "0 * * * *", "Hourly", "maia", 0, now, "cron_echo", "{}");
    _setTestContext(ctx);

    const req = new Request("http://x/api/cron/jobs/patch-job-2", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expression: "*/10 * * * *",
        taskDescription: "Every 10 minutes",
      }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "patch-job-2" }) });
    expect(res.status).toBe(200);
    const job = await res.json() as { id: string; expression: string; taskDescription: string; scheduleDescription?: string; nextRunAt?: string };
    expect(job.expression).toBe("*/10 * * * *");
    expect(job.taskDescription).toBe("Every 10 minutes");
    expect(job.scheduleDescription).toBeDefined();
    expect(job.scheduleDescription).toMatch(/10 minutes/i);
    expect(job.nextRunAt).toBeDefined();

    const row = ctx.db.prepare("SELECT expression, task_description FROM cron_jobs WHERE id = ?").get("patch-job-2") as { expression: string; task_description: string };
    expect(row.expression).toBe("*/10 * * * *");
    expect(row.task_description).toBe("Every 10 minutes");
  });
});
