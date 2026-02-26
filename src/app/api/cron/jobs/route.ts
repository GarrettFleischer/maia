import { NextResponse } from "next/server";
import { getAppContext } from "@/instrumentation";
import type { CronJob } from "@/lib/types";

export async function GET() {
  const { db } = getAppContext();
  const rows = db.prepare("SELECT * FROM cron_jobs ORDER BY created_at").all() as Record<string, unknown>[];
  const jobs: CronJob[] = rows.map((r) => ({
    id: r.id as string,
    expression: r.expression as string,
    taskDescription: r.task_description as string,
    agentId: r.agent_id as string,
    isBuiltIn: Boolean(r.is_built_in),
    createdAt: r.created_at as string,
    toolName: (r.tool_name as string) ?? "cron_echo",
    toolArgs: r.tool_args != null ? (JSON.parse(r.tool_args as string) as Record<string, unknown>) : {},
  }));
  return NextResponse.json({ jobs });
}
