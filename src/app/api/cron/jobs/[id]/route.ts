/**
 * @fileoverview API route: update a single cron job by id (expression, wake fields). Maia-only; built-ins read-only.
 * @module app/api/cron/jobs/[id]/route
 */
import { NextRequest, NextResponse } from "next/server";
import cron from "node-cron";
import { ensureAppContext } from "@/instrumentation";
import { refreshCronJob, unscheduleCronJob } from "@/lib/cron/service";
import { describeCronSchedule, getNextCronRun } from "@/lib/cron/describe";
import { DEFAULT_CRON_WAKE_PROMPT } from "@/lib/cron/default-wake-prompt";
import type { CronJob } from "@/lib/types";
import { getPersonaById } from "@/lib/personas/registry";
import { getSettings } from "@/lib/settings";

type CronRow = {
  id: string;
  expression: string;
  task_description: string;
  agent_id: string;
  is_built_in: number;
  created_at: string;
  tool_name: string;
  tool_args: string;
  persona_id: string | null;
  persona_model: string | null;
  cron_message: string | null;
};

function parseToolArgs(json: string | null | undefined): Record<string, unknown> {
  if (json == null || json === "") return {};
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToCronJob(row: CronRow): CronJob {
  const expression = row.expression;
  return {
    id: row.id,
    expression,
    taskDescription: row.task_description,
    agentId: row.agent_id,
    isBuiltIn: Boolean(row.is_built_in),
    createdAt: row.created_at,
    toolName: row.tool_name ?? "cron_echo",
    toolArgs: parseToolArgs(row.tool_args),
    personaId: row.persona_id ?? null,
    personaModel: row.persona_model ?? null,
    cronMessage: row.cron_message ?? null,
    scheduleDescription: describeCronSchedule(expression),
    nextRunAt: getNextCronRun(expression) ?? undefined,
  };
}

/**
 * PATCH /api/cron/jobs/:id
 * Update a cron job and re-schedule it in-process.
 * @param req - JSON body: expression?, taskDescription?, personaId?, personaModel?, cronMessage?
 * @returns 200 with updated job (with scheduleDescription, nextRunAt), 400 if invalid, 404 if not found
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;

  const row = ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args, persona_id, persona_model, cron_message FROM cron_jobs WHERE id = ?",
    )
    .get(id) as CronRow | undefined;

  if (!row) {
    return NextResponse.json({ error: "Cron job not found" }, { status: 404 });
  }
  if (row.is_built_in) {
    return NextResponse.json(
      { error: "Built-in schedules cannot be modified here." },
      { status: 400 },
    );
  }

  let body: {
    expression?: string;
    taskDescription?: string;
    personaId?: string | null;
    personaModel?: string | null;
    cronMessage?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let expression = row.expression;
  let task_description = row.task_description;
  let persona_id = row.persona_id ?? null;
  let persona_model = row.persona_model ?? null;
  let cron_message = row.cron_message ?? null;

  if (body.expression !== undefined) {
    const expr = String(body.expression).trim();
    if (!cron.validate(expr)) {
      return NextResponse.json(
        { error: "Invalid cron expression" },
        { status: 400 },
      );
    }
    expression = expr;
  }
  if (body.taskDescription !== undefined) {
    task_description = String(body.taskDescription);
  }

  if (body.personaId !== undefined) {
    if (body.personaId === null || body.personaId === "") {
      persona_id = null;
      persona_model = null;
    } else {
      persona_id = String(body.personaId).trim();
    }
  }
  if (body.personaModel !== undefined) {
    if (body.personaModel === null || body.personaModel === "") {
      persona_model = null;
    } else {
      persona_model = String(body.personaModel).trim();
    }
  }
  if (body.cronMessage !== undefined) {
    cron_message =
      body.cronMessage === null ? null : String(body.cronMessage);
  }

  const personaSlugFinal = (persona_id ?? "").trim() || null;
  if (
    personaSlugFinal &&
    (cron_message === null ||
      (typeof cron_message === "string" && cron_message.trim() === ""))
  ) {
    cron_message = DEFAULT_CRON_WAKE_PROMPT;
  }

  if (
    !personaSlugFinal &&
    (cron_message === null ||
      (typeof cron_message === "string" && cron_message.trim() === ""))
  ) {
    cron_message = DEFAULT_CRON_WAKE_PROMPT;
  }

  const personaSlug = personaSlugFinal;
  if (personaSlug) {
    const pm = persona_model?.trim();
    if (!pm) {
      return NextResponse.json(
        { error: "personaModel is required when personaId is set" },
        { status: 400 },
      );
    }
    const persona = getPersonaById(personaSlug);
    if (!persona) {
      return NextResponse.json(
        { error: `Unknown persona: ${personaSlug}` },
        { status: 400 },
      );
    }
    const settings = getSettings(ctx);
    if (!settings.whitelistedModels.includes(pm)) {
      return NextResponse.json(
        { error: `personaModel is not whitelisted: ${pm}` },
        { status: 400 },
      );
    }
  }

  const maiaExists = ctx.db
    .prepare("SELECT 1 FROM agents WHERE id = ? AND status != 'deleted'")
    .get("maia");
  if (!maiaExists) {
    return NextResponse.json(
      { error: 'Orchestrator agent "maia" is required for schedules.' },
      { status: 400 },
    );
  }

  ctx.db
    .prepare(
      "UPDATE cron_jobs SET expression = ?, task_description = ?, tool_name = ?, tool_args = ?, agent_id = ?, persona_id = ?, persona_model = ?, cron_message = ? WHERE id = ?",
    )
    .run(
      expression,
      task_description,
      "cron_echo",
      "{}",
      "maia",
      persona_id,
      persona_model,
      cron_message,
      id,
    );

  refreshCronJob(id);

  const updated = ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args, persona_id, persona_model, cron_message FROM cron_jobs WHERE id = ?",
    )
    .get(id) as CronRow;

  return NextResponse.json(rowToCronJob(updated));
}

/**
 * DELETE /api/cron/jobs/:id
 * Removes a user-created job from SQLite and the in-process scheduler. Built-in jobs are rejected.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;
  const row = ctx.db
    .prepare("SELECT is_built_in FROM cron_jobs WHERE id = ?")
    .get(id) as { is_built_in: number } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Cron job not found" }, { status: 404 });
  }
  if (row.is_built_in) {
    return NextResponse.json(
      { error: "Built-in schedules cannot be deleted here." },
      { status: 400 },
    );
  }
  ctx.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  unscheduleCronJob(id);
  return NextResponse.json({ ok: true });
}
