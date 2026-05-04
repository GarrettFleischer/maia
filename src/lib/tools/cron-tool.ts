/**
 * @fileoverview Cron tools: schedule/list/delete jobs and echo helper for legacy tool-first wakes.
 * @module lib/tools/cron-tool
 */
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import type { CronJob } from "../types";
import { unscheduleCronJob } from "../cron/service";
import { DEFAULT_CRON_WAKE_PROMPT } from "../cron/default-wake-prompt";
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

/**
 * @brief Wake the agent with the given message; no other context. Used by cron for legacy tool-first wakes.
 */
export const cronEchoTool = makeTool(
  "cron_echo",
  "Wake the agent with a message; no other context. Used by cron. Example: cron_echo({ msg: 'ping' }).",
  z.object({
    msg: z.string().optional().describe("Message to echo"),
    message: z.string().optional().describe("Legacy alias for msg"),
  }),
  async (args, _ctx) => args.msg ?? args.message ?? "",
);

const cronScheduleArgsSchema = z.object({
  id: z
    .string()
    .describe(
      'Target agent id — use maia for orchestrator / delegated persona wakes. Other ids only for legacy tool-first jobs.',
    ),
  expr: z.string().describe("5-field cron expression e.g. '0 9 * * 1'"),
  tool: z
    .string()
    .optional()
    .describe(
      "Registered tool for legacy wakes ([CRON] + initialToolCall). Omit when using prompt_wake, cron_message, or persona_id.",
    ),
  args: z
    .union([
      z.record(z.string(), z.unknown()),
      z
        .string()
        .describe("JSON object as string e.g. '{}' or '{\"msg\":\"Daily\"}'"),
    ])
    .optional()
    .describe(
      "Arguments for legacy tool wake (object or JSON string). Defaults to {}.",
    ),
  desc: z.string().optional().describe("Short label for listing"),
  persona_id: z
    .string()
    .optional()
    .describe(
      "Catalog persona slug for delegated wakes (requires maia + persona_model). Uses cron_message or default task-review prompt.",
    ),
  persona_model: z
    .string()
    .optional()
    .describe("Whitelist model id when persona_id is set (e.g. ollama/llama3.2)."),
  cron_message: z
    .string()
    .optional()
    .describe(
      "Custom user message for prompt or persona wakes; omit with prompt_wake for default task-review instructions.",
    ),
  prompt_wake: z
    .boolean()
    .optional()
    .describe(
      "When true (without persona_id), schedules Maia prompt wake with DEFAULT task-review message.",
    ),
});

function normalizeCronScheduleArgs(
  args: z.infer<typeof cronScheduleArgsSchema>["args"],
): Record<string, unknown> {
  if (args === undefined) return {};
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error(
        'cron_schedule args must be a JSON object string, e.g. {} or {"msg":"hi"}',
      );
    }
    throw new Error(
      "cron_schedule args must be a JSON object, not array or primitive",
    );
  }
  return args;
}

export const cronScheduleTool = makeTool(
  "cron_schedule",
  "Schedule a recurring cron job. Three wakes: (1) Legacy tool-first: tool+args → agent sees [CRON] then forced tool result. (2) Prompt wake: prompt_wake and/or cron_message → free-form message (default reminds Maia to use task_list/task_update). (3) Delegated persona: persona_id + persona_model on maia → persona_turn with cron_message or default. Maia only. Example persona: cron_schedule({ id: 'maia', expr: '0 9 * * *', persona_id: 'typescript-pro', persona_model: 'ollama/llama3.2', desc: 'Morning persona sweep' }).",
  cronScheduleArgsSchema,
  async (args, ctx) => {
    const targetAgentId = args.id.trim();
    const expression = args.expr.trim();
    const taskDescription =
      args.desc ?? `${args.persona_id ?? "cron"}(${expression})`;

    const agentExists = ctx.db
      .prepare("SELECT 1 FROM agents WHERE id = ? AND status != 'deleted'")
      .get(targetAgentId);
    if (!agentExists) {
      throw new Error(
        `Target agent not found or deleted: ${targetAgentId}. Use the agents table / Maia orchestrator to resolve valid agent ids.`,
      );
    }

    const personaSlug = args.persona_id?.trim();
    const personaModelArg = args.persona_model?.trim();
    const promptWake = args.prompt_wake === true;
    const cronMsgArg = args.cron_message;

    let personaIdDb: string | null = null;
    let personaModelDb: string | null = null;
    let cronMessageDb: string | null = null;
    let toolNameInsert: string;
    let toolArgsInsert: Record<string, unknown>;

    if (personaSlug) {
      if (targetAgentId !== "maia") {
        throw new Error(
          'Cron jobs with persona_id must target maia — pass id: "maia".',
        );
      }
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
      toolNameInsert = "cron_echo";
      toolArgsInsert = {};
    } else if (promptWake || cronMsgArg !== undefined) {
      cronMessageDb =
        cronMsgArg !== undefined && String(cronMsgArg).trim() !== ""
          ? String(cronMsgArg).trim()
          : DEFAULT_CRON_WAKE_PROMPT;
      toolNameInsert = "cron_echo";
      toolArgsInsert = {};
    } else {
      const toolRaw = args.tool?.trim();
      if (!toolRaw) {
        throw new Error(
          "Provide tool+args for legacy tool wake, prompt_wake / cron_message for a prompt wake, or persona_id+persona_model for a delegated persona wake.",
        );
      }
      toolNameInsert = toolRaw;
      toolArgsInsert = normalizeCronScheduleArgs(args.args);
      personaIdDb = null;
      personaModelDb = null;
      cronMessageDb = null;
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
        taskDescription,
        targetAgentId,
        now,
        toolNameInsert,
        JSON.stringify(toolArgsInsert),
        personaIdDb,
        personaModelDb,
        cronMessageDb,
      );
    return jobId;
  },
);

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
        toolArgs:
          r.tool_args != null
            ? (JSON.parse(r.tool_args as string) as Record<string, unknown>)
            : {},
        personaId: (r.persona_id as string | null | undefined) ?? null,
        personaModel: (r.persona_model as string | null | undefined) ?? null,
        cronMessage: (r.cron_message as string | null | undefined) ?? null,
      }),
    );
  },
);

export const cronDeleteTool = makeTool(
  "cron_delete",
  "Delete a cron job by ID. Use cron_list first to find the job ID. Any job can be deleted, including built-in or system jobs. Maia only. Example: cron_delete({ id: 'uuid' }).",
  z.object({ id: z.string().describe("Job ID") }),
  async ({ id: jobId }, ctx) => {
    const row = ctx.db
      .prepare("SELECT 1 FROM cron_jobs WHERE id = ?")
      .get(jobId);
    if (!row) throw new Error(`Cron job not found: ${jobId}`);
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
