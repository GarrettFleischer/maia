/**
 * @fileoverview API route: list cron jobs with human-readable schedule and next run time; create user jobs.
 * @module app/api/cron/jobs/route
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext, ensureAppContext } from "@/instrumentation";
import type { CronJob } from "@/lib/types";
import { describeCronSchedule, getNextCronRun } from "@/lib/cron/describe";
import {
  insertUserCronJob,
  CronJobValidationError,
} from "@/lib/cron/create-cron-job";
import { refreshCronJob } from "@/lib/cron/service";
import { createTask } from "@/lib/tasks";

const createJobSchema = z.object({
  expression: z.string().min(1),
  taskDescription: z.string().min(1),
  wakeType: z.enum(["wake_up", "custom"]),
  delegateTo: z.enum(["maia", "persona"]),
  personaId: z.string().optional(),
  personaModel: z.string().optional(),
  customMessage: z.string().optional(),
  boardTask: z
    .object({
      title: z.string().min(1),
      description: z.string().optional(),
      assignedTo: z.string().nullable().optional(),
    })
    .optional(),
});

function parseListedToolArgs(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === "") return {};
  try {
    const v = JSON.parse(String(raw)) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToListedJob(r: Record<string, unknown>): CronJob {
  const expression = r.expression as string;
  return {
    id: r.id as string,
    expression,
    taskDescription: r.task_description as string,
    agentId: r.agent_id as string,
    isBuiltIn: Boolean(r.is_built_in),
    createdAt: r.created_at as string,
    toolName: (r.tool_name as string) ?? "cron_echo",
    toolArgs: parseListedToolArgs(r.tool_args),
    personaId: (r.persona_id as string | null | undefined) ?? null,
    personaModel: (r.persona_model as string | null | undefined) ?? null,
    cronMessage: (r.cron_message as string | null | undefined) ?? null,
    scheduleDescription: describeCronSchedule(expression),
    nextRunAt: getNextCronRun(expression) ?? undefined,
  };
}

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
  const jobs: CronJob[] = rows.map(rowToListedJob);
  return NextResponse.json({ jobs });
}

/**
 * POST /api/cron/jobs
 * Creates a user-defined schedule (wake-up or custom message; Maia or delegated persona).
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await ensureAppContext();
    let body: z.infer<typeof createJobSchema>;
    try {
      body = createJobSchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    let jobId: string;
    try {
      jobId = insertUserCronJob(ctx, {
        expression: body.expression,
        taskDescription: body.taskDescription,
        wakeType: body.wakeType,
        delegateTo: body.delegateTo,
        personaId: body.personaId,
        personaModel: body.personaModel,
        customMessage: body.customMessage,
      });
    } catch (e) {
      if (e instanceof CronJobValidationError) {
        return NextResponse.json({ error: e.message }, { status: e.statusCode });
      }
      throw e;
    }

    if (body.boardTask) {
      const cronLine = `Cron job id: ${jobId}`;
      createTask(ctx, {
        title: body.boardTask.title,
        description: [body.boardTask.description, cronLine].filter(Boolean).join("\n\n"),
        assignedTo: body.boardTask.assignedTo ?? null,
        createdBy: "user",
      });
    }

    refreshCronJob(jobId);

    const row = ctx.db
      .prepare("SELECT * FROM cron_jobs WHERE id = ?")
      .get(jobId) as Record<string, unknown>;
    return NextResponse.json(rowToListedJob(row), { status: 201 });
  } catch (e) {
    console.error("[POST /api/cron/jobs]", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
