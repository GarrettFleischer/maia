import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import type { CronJob } from "../types";
import { BUILTIN_HEARTBEAT_JOB_ID } from "../cron/expression";

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
 * Wakes the agent with the given message; no other context. Used by cron to trigger a run with a payload.
 * Returns the message so the agent sees it as the cron payload.
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

export const cronScheduleTool = makeTool(
  "cron_schedule",
  "Schedule a recurring cron job that invokes any tool (with args) on a schedule for a target agent. Use cron_list first to see existing jobs and avoid duplicates. Maia only. Example: cron_schedule({ id: 'maia', expr: '0 9 * * *', tool: 'cron_echo', args: { msg: 'Daily sync' }, desc: 'Daily sync' }).",
  z.object({
    id: z.string().describe("Target agent ID (the agent that will run when the job fires)"),
    expr: z.string().describe("5-field cron expression e.g. '0 9 * * 1'"),
    tool: z.string().describe("Any registered tool name e.g. cron_echo, web_search, task_list"),
    args: z.record(z.string(), z.unknown()).describe("Arguments for the tool"),
    desc: z.string().optional().describe("Short label for listing"),
  }),
  async (
    { id: targetAgentId, expr: expression, tool: toolName, args: toolArgs, desc: taskDescription },
    ctx,
  ) => {
    const agentExists = ctx.db
      .prepare("SELECT 1 FROM agents WHERE id = ? AND status != 'deleted'")
      .get(targetAgentId);
    if (!agentExists) {
      throw new Error(`Target agent not found or deleted: ${targetAgentId}. Use agent_list to see valid IDs.`);
    }
    const jobId = uuidv4();
    const now = new Date().toISOString();
    const label = taskDescription ?? `${toolName}(${JSON.stringify(toolArgs)})`;
    ctx.db
      .prepare(
        `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        jobId,
        expression,
        label,
        targetAgentId,
        now,
        toolName,
        JSON.stringify(toolArgs),
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
      }),
    );
  },
);

export const cronDeleteTool = makeTool(
  "cron_delete",
  "Delete a cron job by ID. Use cron_list first to find the job ID. Cannot delete built-in jobs. Maia only. Example: cron_delete({ id: 'uuid' }).",
  z.object({ id: z.string().describe("Job ID") }),
  async ({ id: jobId }, ctx) => {
    if (jobId === BUILTIN_HEARTBEAT_JOB_ID) {
      throw new Error("Cannot delete built-in cron jobs");
    }
    const row = ctx.db
      .prepare("SELECT is_built_in FROM cron_jobs WHERE id = ?")
      .get(jobId) as { is_built_in: number } | undefined;
    if (!row) throw new Error(`Cron job not found: ${jobId}`);
    if (row.is_built_in) throw new Error("Cannot delete built-in cron jobs");
    ctx.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(jobId);
  },
);

export const cronTools: Tool[] = [
  cronEchoTool,
  cronScheduleTool,
  cronListTool,
  cronDeleteTool,
];
