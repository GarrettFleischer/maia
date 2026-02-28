/**
 * @fileoverview API route: list cron jobs with human-readable schedule and next run time.
 * @module app/api/cron/jobs/route
 */
import { NextResponse } from "next/server";
import { getAppContext } from "@/instrumentation";
import type { CronJob } from "@/lib/types";
import { describeCronSchedule, getNextCronRun } from "@/lib/cron/describe";

/**
 * GET /api/cron/jobs
 * Returns all cron jobs with scheduleDescription and nextRunAt.
 * @returns {Promise<NextResponse>} JSON body: { jobs: CronJob[] }
 */
export async function GET() {
  const { db } = getAppContext();
  const rows = db
    .prepare("SELECT * FROM cron_jobs ORDER BY created_at")
    .all() as Record<string, unknown>[];
  const jobs: CronJob[] = rows.map((r) => {
    const expression = r.expression as string;
    return {
      id: r.id as string,
      expression,
      taskDescription: r.task_description as string,
      agentId: r.agent_id as string,
      isBuiltIn: Boolean(r.is_built_in),
      createdAt: r.created_at as string,
      toolName: (r.tool_name as string) ?? "cron_echo",
      toolArgs:
        r.tool_args != null
          ? (JSON.parse(r.tool_args as string) as Record<string, unknown>)
          : {},
      scheduleDescription: describeCronSchedule(expression),
      nextRunAt: getNextCronRun(expression) ?? undefined,
    };
  });
  return NextResponse.json({ jobs });
}
