/**
 * @fileoverview Dashboard API: aggregated agents, task counts, recent agent sessions, cron jobs for the monitor UI.
 * @module app/api/dashboard/route
 *
 * GET /api/dashboard — returns 200 with JSON body for the agents monitor dashboard.
 * @returns 200 OK with body: { agents, taskCountsByStatus, taskCountsByAgent, recentAgentSessions, cronJobs }
 * @example
 * // Response shape
 * {
 *   agents: [{ id, name, model, status, createdAt, updatedAt }, ...],
 *   taskCountsByStatus: { todo: number, in_progress: number, done: number },
 *   taskCountsByAgent: { [agentId]: { todo, in_progress, done }, ... },
 *   recentAgentSessions: [{ id, name, participants, updatedAt }, ...],
 *   cronJobs: [{ id, expression, taskDescription, agentId, isBuiltIn, createdAt, toolName, toolArgs }, ...]
 * }
 */

import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { listAgents } from "@/lib/agent/identity";
import { listSessions } from "@/lib/history";
import type { CronJob } from "@/lib/types";
import { describeCronSchedule, getNextCronRun } from "@/lib/cron/describe";

const RECENT_AGENT_SESSIONS_LIMIT = 10;

export async function GET() {
  const ctx = await ensureAppContext();

  const agents = listAgents(ctx);

  const statusRows = ctx.db
    .prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
    .all() as { status: string; count: number }[];
  const taskCountsByStatus = { todo: 0, in_progress: 0, done: 0 };
  for (const row of statusRows) {
    if (row.status in taskCountsByStatus) {
      (taskCountsByStatus as Record<string, number>)[row.status] = row.count;
    }
  }

  const assignedRows = ctx.db
    .prepare(
      "SELECT assigned_to AS agent_id, status, COUNT(*) as count FROM tasks WHERE assigned_to IS NOT NULL GROUP BY assigned_to, status",
    )
    .all() as { agent_id: string; status: string; count: number }[];
  const taskCountsByAgent: Record<
    string,
    { todo: number; in_progress: number; done: number }
  > = {};
  for (const a of agents) {
    taskCountsByAgent[a.id] = { todo: 0, in_progress: 0, done: 0 };
  }
  for (const row of assignedRows) {
    if (!taskCountsByAgent[row.agent_id]) {
      taskCountsByAgent[row.agent_id] = { todo: 0, in_progress: 0, done: 0 };
    }
    if (row.status in taskCountsByAgent[row.agent_id]) {
      (taskCountsByAgent[row.agent_id] as Record<string, number>)[row.status] =
        row.count;
    }
  }

  const agentSessions = listSessions(ctx, "agents").slice(
    0,
    RECENT_AGENT_SESSIONS_LIMIT,
  );
  const recentAgentSessions = agentSessions.map((s) => ({
    id: s.id,
    name: s.name,
    participants: s.participants,
    updatedAt: s.updatedAt,
  }));

  const cronRows = ctx.db
    .prepare("SELECT * FROM cron_jobs ORDER BY created_at")
    .all() as Record<string, unknown>[];
  const cronJobs: CronJob[] = cronRows.map((r) => {
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

  return NextResponse.json({
    agents,
    taskCountsByStatus,
    taskCountsByAgent,
    recentAgentSessions,
    cronJobs,
  });
}
