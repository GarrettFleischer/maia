/**
 * @fileoverview Cron tools: schedule/list/delete jobs and `cron_echo` helper for ad-hoc pings.
 * @module lib/tools/cron-tool
 */
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import type { CronJob } from "../types";
import { unscheduleCronJob } from "../cron/service";
import { DEFAULT_CRON_WAKE_PROMPT } from "../cron/default-wake-prompt";
import { persistCronJobRow } from "../cron/create-cron-job";
import { getPersonaById } from "../personas/registry";
import { getSettings } from "../settings";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>,
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({
      name,
      description,
      parameters: zodToJsonSchema(schema),
    }),
  };
}

export const cronEchoTool = makeTool(
  "cron_echo",
  "Echo a short message (testing or lightweight agent pings). Example: cron_echo({ msg: 'ping' }).",
  z.object({
    msg: z.string().optional().describe("Message to echo"),
    message: z.string().optional().describe("Alias for msg"),
  }),
  async (args, _ctx) => args.msg ?? args.message ?? "",
);

const cronScheduleArgsSchema = z.object({
  id: z
    .string()
    .describe('Must be "maia" — all schedules run on the orchestrator.'),
  expr: z.string().describe("5-field cron expression e.g. '0 9 * * 1'"),
  desc: z.string().optional().describe("Short label for listing"),
  persona_id: z
    .string()
    .optional()
    .describe(
      "Catalog persona slug for delegated wakes (requires persona_model). Uses cron_message or default task-review prompt.",
    ),
  persona_model: z
    .string()
    .optional()
    .describe("Whitelist model id when persona_id is set (e.g. ollama/llama3.2)."),
  cron_message: z
    .string()
    .optional()
    .describe(
      "Custom wake text for Maia or persona; omit with prompt_wake for default task-review instructions.",
    ),
  prompt_wake: z
    .boolean()
    .optional()
    .describe(
      "When true (without persona_id), schedules Maia prompt wake with DEFAULT task-review message.",
    ),
});

export const cronScheduleTool = makeTool(
  "cron_schedule",
  'Schedule a recurring wake on Maia only. Use prompt_wake: true and/or cron_message for a direct Maia prompt wake, or persona_id + persona_model for a delegated persona harness. Example: cron_schedule({ id: "maia", expr: "0 9 * * *", persona_id: "typescript-pro", persona_model: "ollama/llama3.2", desc: "Morning persona sweep" }).',
  cronScheduleArgsSchema,
  async (args, ctx) => {
    const targetAgentId = args.id.trim();
    if (targetAgentId !== "maia") {
      throw new Error('cron_schedule requires id: "maia".');
    }
    const expression = args.expr.trim();
    const taskDescription =
      args.desc ?? `${args.persona_id ?? "cron"}(${expression})`;

    const personaSlug = args.persona_id?.trim();
    const personaModelArg = args.persona_model?.trim();
    const promptWake = args.prompt_wake === true;
    const cronMsgArg = args.cron_message;

    let personaIdDb: string | null = null;
    let personaModelDb: string | null = null;
    let cronMessageDb: string | null = null;

    if (personaSlug) {
      if (!personaModelArg) {
        throw new Error("persona_model is required when persona_id is set.");
      }
      const persona = getPersonaById(personaSlug);
      if (!persona) {
        throw new Error(`Unknown persona: ${personaSlug}. Use persona_list first.`);
      }
      const settings = getSettings(ctx);
      if (!settings.whitelistedModels.includes(personaModelArg)) {
        throw new Error(
          `persona_model is not whitelisted: ${personaModelArg}. Pick a model from settings.`,
        );
      }
      personaIdDb = personaSlug;
      personaModelDb = personaModelArg;
      cronMessageDb =
        cronMsgArg !== undefined && String(cronMsgArg).trim() !== ""
          ? String(cronMsgArg).trim()
          : DEFAULT_CRON_WAKE_PROMPT;
    } else if (promptWake || cronMsgArg !== undefined) {
      cronMessageDb =
        cronMsgArg !== undefined && String(cronMsgArg).trim() !== ""
          ? String(cronMsgArg).trim()
          : DEFAULT_CRON_WAKE_PROMPT;
    } else {
      throw new Error(
        "Set prompt_wake: true, or cron_message, or persona_id with persona_model.",
      );
    }

    const jobId = persistCronJobRow(ctx, {
      expression,
      taskDescription,
      agentId: "maia",
      toolName: "cron_echo",
      toolArgs: {},
      personaId: personaIdDb,
      personaModel: personaModelDb,
      cronMessage: cronMessageDb,
    });
    return jobId;
  },
);

function parseToolArgsJson(raw: string | null | undefined): Record<string, unknown> {
  if (raw == null || raw === "") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export const cronListTool = makeTool(
  "cron_list",
  "List all cron jobs. Maia only. Example: cron_list({}).",
  z.object({}),
  async (_args, ctx) => {
    const rows = ctx.db
      .prepare("SELECT * FROM cron_jobs ORDER BY created_at")
      .all() as Record<string, unknown>[];
    return rows.map(
      (r): CronJob => ({
        id: r.id as string,
        expression: r.expression as string,
        taskDescription: r.task_description as string,
        agentId: r.agent_id as string,
        isBuiltIn: Boolean(r.is_built_in),
        createdAt: r.created_at as string,
        toolName: (r.tool_name as string) ?? "cron_echo",
        toolArgs: parseToolArgsJson(r.tool_args as string | undefined),
        personaId: (r.persona_id as string | null | undefined) ?? null,
        personaModel: (r.persona_model as string | null | undefined) ?? null,
        cronMessage: (r.cron_message as string | null | undefined) ?? null,
      }),
    );
  },
);

export const cronDeleteTool = makeTool(
  "cron_delete",
  "Delete a user cron job by ID. Built-in jobs cannot be deleted. Example: cron_delete({ id: 'uuid' }).",
  z.object({ id: z.string().describe("Job ID") }),
  async ({ id: jobId }, ctx) => {
    const row = ctx.db
      .prepare("SELECT is_built_in FROM cron_jobs WHERE id = ?")
      .get(jobId) as { is_built_in: number } | undefined;
    if (!row) throw new Error(`Cron job not found: ${jobId}`);
    if (row.is_built_in) {
      throw new Error("Built-in schedules cannot be deleted with cron_delete.");
    }
    ctx.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(jobId);
    unscheduleCronJob(jobId);
    return { success: true, message: "Cron job deleted." };
  },
);

export const cronTools: Tool[] = [
  cronEchoTool,
  cronScheduleTool,
  cronListTool,
  cronDeleteTool,
];
