/**
 * @fileoverview API route: update a single cron job by id (expression, wake mode fields, agent).
 * @module app/api/cron/jobs/[id]/route
 */
import { NextRequest, NextResponse } from "next/server";
import cron from "node-cron";
import { ensureAppContext } from "@/instrumentation";
import { refreshCronJob } from "@/lib/cron/service";
import { describeCronSchedule, getNextCronRun } from "@/lib/cron/describe";
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
    toolArgs: row.tool_args
      ? (JSON.parse(row.tool_args) as Record<string, unknown>)
      : {},
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
 * @param req - JSON body: expression?, taskDescription?, toolName?, toolArgs?, agentId?, personaId?, personaModel?, cronMessage?
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

  let body: {
    expression?: string;
    taskDescription?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    agentId?: string;
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
  let tool_name = row.tool_name;
  let tool_args = row.tool_args;
  let agent_id = row.agent_id;
  let persona_id = row.persona_id ?? null;
  let persona_model = row.persona_model ?? null;
  let cron_message = row.cron_message ?? null;

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
  if (body.agentId !== undefined) {
    const targetId = String(body.agentId).trim();
    if (!targetId) {
      return NextResponse.json(
        { error: "Target agent ID is required and cannot be empty" },
        { status: 400 },
      );
    }
    const agentExists = ctx.db
      .prepare("SELECT 1 FROM agents WHERE id = ? AND status != 'deleted'")
      .get(targetId);
    if (!agentExists) {
      return NextResponse.json(
        { error: `Target agent not found or deleted: ${targetId}` },
        { status: 400 },
      );
    }
    agent_id = targetId;
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

  const personaSlug = persona_id?.trim();
  if (personaSlug) {
    if (agent_id !== "maia") {
      return NextResponse.json(
        {
          error:
            'Delegated persona cron jobs must target agent id "maia".',
        },
        { status: 400 },
      );
    }
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

  ctx.db
    .prepare(
      "UPDATE cron_jobs SET expression = ?, task_description = ?, tool_name = ?, tool_args = ?, agent_id = ?, persona_id = ?, persona_model = ?, cron_message = ? WHERE id = ?",
    )
    .run(
      expression,
      task_description,
      tool_name,
      tool_args,
      agent_id,
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
