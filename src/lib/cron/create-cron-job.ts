/**
 * @fileoverview Insert cron job rows (shared by `cron_schedule` tool and POST /api/cron/jobs).
 * @module lib/cron/create-cron-job
 */
import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";
import type { AppContext } from "../context";
import { DEFAULT_CRON_WAKE_PROMPT } from "./default-wake-prompt";
import { getPersonaById } from "../personas/registry";
import { getSettings } from "../settings";

/** Thrown when UI or API validation fails before insert. */
export class CronJobValidationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "CronJobValidationError";
    this.statusCode = statusCode;
  }
}

export type PersistCronJobRowInput = {
  expression: string;
  taskDescription: string;
  agentId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  personaId: string | null;
  personaModel: string | null;
  cronMessage: string | null;
};

/**
 * Inserts a non-built-in cron_jobs row. Validates cron expression and target agent.
 */
export function persistCronJobRow(ctx: AppContext, row: PersistCronJobRowInput): string {
  const expression = row.expression.trim();
  if (!cron.validate(expression)) {
    throw new CronJobValidationError("Invalid cron expression");
  }
  const agentId = row.agentId.trim();
  const exists = ctx.db
    .prepare("SELECT 1 FROM agents WHERE id = ? AND status != 'deleted'")
    .get(agentId);
  if (!exists) {
    throw new CronJobValidationError(
      `Target agent not found or deleted: ${agentId}. Use a valid agent id (usually "maia").`,
    );
  }
  if (agentId !== "maia") {
    throw new CronJobValidationError(
      'Scheduled jobs must use agent id "maia".',
    );
  }

  const personaSlug =
    row.personaId != null && String(row.personaId).trim() !== ""
      ? String(row.personaId).trim()
      : null;
  if (personaSlug) {
    const pm =
      row.personaModel != null && String(row.personaModel).trim() !== ""
        ? String(row.personaModel).trim()
        : null;
    if (!pm) {
      throw new CronJobValidationError("personaModel is required when a persona is set");
    }
    const persona = getPersonaById(personaSlug);
    if (!persona) {
      throw new CronJobValidationError(`Unknown persona: ${personaSlug}`);
    }
    const settings = getSettings(ctx);
    if (!settings.whitelistedModels.includes(pm)) {
      throw new CronJobValidationError(`Model is not whitelisted: ${pm}`);
    }
  } else if (
    row.personaModel != null &&
    String(row.personaModel).trim() !== ""
  ) {
    throw new CronJobValidationError("personaModel without personaId is invalid");
  }

  const jobId = uuidv4();
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args, persona_id, persona_model, cron_message)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      expression,
      row.taskDescription.trim() || `Schedule (${expression})`,
      agentId,
      now,
      row.toolName || "cron_echo",
      JSON.stringify(row.toolArgs ?? {}),
      personaSlug,
      personaSlug ? String(row.personaModel).trim() : null,
      row.cronMessage,
    );
  return jobId;
}

/** Body shape for POST /api/cron/jobs (friendly schedule builder). */
export type CronUiCreatePayload = {
  expression: string;
  taskDescription: string;
  wakeType: "wake_up" | "custom";
  delegateTo: "maia" | "persona";
  personaId?: string;
  personaModel?: string;
  customMessage?: string;
};

/**
 * Creates a user-defined cron job from the simplified UI payload.
 */
export function insertUserCronJob(ctx: AppContext, input: CronUiCreatePayload): string {
  const delegate = input.delegateTo;
  if (delegate === "maia") {
    if (input.wakeType === "wake_up") {
      return persistCronJobRow(ctx, {
        expression: input.expression,
        taskDescription: input.taskDescription,
        agentId: "maia",
        toolName: "cron_echo",
        toolArgs: {},
        personaId: null,
        personaModel: null,
        cronMessage: DEFAULT_CRON_WAKE_PROMPT,
      });
    }
    const msg = (input.customMessage ?? "").trim();
    if (!msg) {
      throw new CronJobValidationError("Custom wake message is required");
    }
    return persistCronJobRow(ctx, {
      expression: input.expression,
      taskDescription: input.taskDescription,
      agentId: "maia",
      toolName: "cron_echo",
      toolArgs: {},
      personaId: null,
      personaModel: null,
      cronMessage: msg,
    });
  }

  const personaSlug = (input.personaId ?? "").trim();
  const personaModel = (input.personaModel ?? "").trim();
  if (!personaSlug) {
    throw new CronJobValidationError("Choose a catalog persona");
  }
  if (!personaModel) {
    throw new CronJobValidationError("Choose a model for the persona");
  }
  const cronMessage =
    input.wakeType === "wake_up"
      ? DEFAULT_CRON_WAKE_PROMPT
      : (() => {
          const m = (input.customMessage ?? "").trim();
          if (!m) {
            throw new CronJobValidationError("Custom wake message is required");
          }
          return m;
        })();
  return persistCronJobRow(ctx, {
    expression: input.expression,
    taskDescription: input.taskDescription,
    agentId: "maia",
    toolName: "cron_echo",
    toolArgs: {},
    personaId: personaSlug,
    personaModel,
    cronMessage,
  });
}
