/**
 * @fileoverview Tests for GET /api/cron/jobs.
 * @module __tests__/app/api/cron/jobs/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { GET } from "@/app/api/cron/jobs/route";

describe("GET /api/cron/jobs", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns jobs array", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { jobs: unknown[] };
    expect(body.jobs).toBeDefined();
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it("returns jobs with mapped shape (id, expression, taskDescription, agentId, isBuiltIn, createdAt)", async () => {
    const ctx = makeTestContext();
    const now = new Date().toISOString();
    ctx.db.prepare(
      "INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("job-1", "0 * * * *", "Hourly task", "maia", 1, now);
    _setTestContext(ctx);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { jobs: Array<{ id: string; expression: string; taskDescription: string; agentId: string; isBuiltIn: boolean; createdAt: string }> };
    expect(body.jobs.length).toBeGreaterThanOrEqual(1);
    const job = body.jobs.find((j) => j.id === "job-1")!;
    expect(job).toBeDefined();
    expect(job.expression).toBe("0 * * * *");
    expect(job.taskDescription).toBe("Hourly task");
    expect(job.agentId).toBe("maia");
    expect(job.isBuiltIn).toBe(true);
    expect(job.createdAt).toBe(now);
  });

  it("returns scheduleDescription and nextRunAt for each job", async () => {
    const ctx = makeTestContext();
    const now = new Date().toISOString();
    ctx.db.prepare(
      "INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("job-desc", "*/15 * * * *", "Every 15 min", "maia", 0, now, "cron_echo", "{}");
    _setTestContext(ctx);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { jobs: Array<{ id: string; scheduleDescription?: string; nextRunAt?: string }> };
    const job = body.jobs.find((j) => j.id === "job-desc");
    expect(job).toBeDefined();
    expect(job!.scheduleDescription).toBeDefined();
    expect(job!.scheduleDescription).toMatch(/15 minutes/i);
    expect(job!.nextRunAt).toBeDefined();
    expect(() => new Date(job!.nextRunAt!).toISOString()).not.toThrow();
  });
});
