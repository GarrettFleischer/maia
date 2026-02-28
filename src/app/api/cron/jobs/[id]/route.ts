/**
 * @fileoverview API route: get or update a single cron job by id.
 * @module app/api/cron/jobs/[id]/route
 */
import { NextRequest, NextResponse } from "next/server";
import cron from "node-cron";
import { ensureAppContext } from "@/instrumentation";
import { refreshCronJob } from "@/lib/cron/service";
import { describeCronSchedule, getNextCronRun } from "@/lib/cron/describe";
import type { CronJob } from "@/lib/types";

/**
 * PATCH /api/cron/jobs/:id
 * Update a cron job (expression, taskDescription, toolName, toolArgs). Re-schedules the job in-process.
 * @param req - JSON body: { expression?, taskDescription?, toolName?, toolArgs? }
 * @returns 200 with updated job (with scheduleDescription, nextRunAt), 400 if expression invalid, 404 if not found
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;

  const row = ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args FROM cron_jobs WHERE id = ?",
    )
    .get(id) as
    | {
        id: string;
        expression: string;
        task_description: string;
        agent_id: string;
        is_built_in: number;
        created_at: string;
        tool_name: string;
        tool_args: string;
      }
    | undefined;

  if (!row) {
    return NextResponse.json({ error: "Cron job not found" }, { status: 404 });
  }

  let body: {
    expression?: string;
    taskDescription?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let expression = row.expression;
  let task_description = row.task_description;
  let tool_name = row.tool_name;
  let tool_args = row.tool_args;

  if (body.expression !== undefined) {
    if (!cron.validate(body.expression)) {
      return NextResponse.json(
        { error: "Invalid cron expression" },
        { status: 400 },
      );
    }
    expression = body.expression;
  }
  if (body.taskDescription !== undefined) {
    task_description = String(body.taskDescription);
  }
  if (body.toolName !== undefined) {
    tool_name = String(body.toolName);
  }
  if (body.toolArgs !== undefined) {
    if (typeof body.toolArgs !== "object" || body.toolArgs === null) {
      return NextResponse.json(
        { error: "toolArgs must be an object" },
        { status: 400 },
      );
    }
    tool_args = JSON.stringify(body.toolArgs);
  }

  ctx.db
    .prepare(
      "UPDATE cron_jobs SET expression = ?, task_description = ?, tool_name = ?, tool_args = ? WHERE id = ?",
    )
    .run(expression, task_description, tool_name, tool_args, id);

  refreshCronJob(id);

  const updated = ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args FROM cron_jobs WHERE id = ?",
    )
    .get(id) as {
    id: string;
    expression: string;
    task_description: string;
    agent_id: string;
    is_built_in: number;
    created_at: string;
    tool_name: string;
    tool_args: string;
  };

  const job: CronJob = {
    id: updated.id,
    expression: updated.expression,
    taskDescription: updated.task_description,
    agentId: updated.agent_id,
    isBuiltIn: Boolean(updated.is_built_in),
    createdAt: updated.created_at,
    toolName: updated.tool_name ?? "cron_echo",
    toolArgs: updated.tool_args
      ? (JSON.parse(updated.tool_args) as Record<string, unknown>)
      : {},
    scheduleDescription: describeCronSchedule(updated.expression),
    nextRunAt: getNextCronRun(updated.expression) ?? undefined,
  };

  return NextResponse.json(job);
}
