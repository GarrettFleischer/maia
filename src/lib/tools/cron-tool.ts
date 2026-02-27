import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import type { CronJob } from "../types";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
): Tool<z.infer<S>> {
  return {
    name, description, schema, execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

/**
 * Echo tool used when a cron job has no specific tool (e.g. legacy jobs with task_description only).
 * Returns the message so the agent sees it as the cron payload.
 */
export const cronEchoTool = makeTool(
  "cron_echo",
  "Echo a message. Used by cron for legacy task_description-only jobs.",
  z.object({ message: z.string().describe("Message to echo") }),
  async ({ message }, _ctx) => message,
);

export const cronScheduleTool = makeTool(
  "cron_schedule",
  "Schedule a recurring cron job that invokes a tool (with args) on a schedule. Use cron_list first to see existing jobs and avoid duplicates. Maia only.",
  z.object({
    expression: z.string().describe("5-field cron expression e.g. '0 9 * * 1'"),
    toolName: z.string().describe("Tool to call when the job fires e.g. cron_echo, web_search"),
    toolArgs: z.record(z.string(), z.unknown()).describe("JSON object of arguments for the tool"),
    taskDescription: z.string().optional().describe("Optional short label for listing (defaults to toolName + args)"),
  }),
  async ({ expression, toolName, toolArgs, taskDescription }, ctx) => {
    const id = uuidv4();
    const now = new Date().toISOString();
    const label = taskDescription ?? `${toolName}(${JSON.stringify(toolArgs)})`;
    ctx.db.prepare(
      `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(id, expression, label, ctx.agentId, now, toolName, JSON.stringify(toolArgs));
    return id;
  }
);

export const cronListTool = makeTool(
  "cron_list",
  "List all cron jobs. Maia only.",
  z.object({}),
  async (_args, ctx) => {
    const rows = ctx.db.prepare("SELECT * FROM cron_jobs ORDER BY created_at").all() as Record<string, unknown>[];
    return rows.map((r): CronJob => ({
      id: r.id as string,
      expression: r.expression as string,
      taskDescription: r.task_description as string,
      agentId: r.agent_id as string,
      isBuiltIn: Boolean(r.is_built_in),
      createdAt: r.created_at as string,
      toolName: (r.tool_name as string) ?? "cron_echo",
      toolArgs: r.tool_args != null ? (JSON.parse(r.tool_args as string) as Record<string, unknown>) : {},
    }));
  }
);

export const cronDeleteTool = makeTool(
  "cron_delete",
  "Delete a cron job by ID. Use cron_list first to find the job ID. Cannot delete built-in jobs. Maia only.",
  z.object({ jobId: z.string() }),
  async ({ jobId }, ctx) => {
    const row = ctx.db.prepare("SELECT is_built_in FROM cron_jobs WHERE id = ?").get(jobId) as { is_built_in: number } | undefined;
    if (!row) throw new Error(`Cron job not found: ${jobId}`);
    if (row.is_built_in) throw new Error("Cannot delete built-in cron jobs");
    ctx.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(jobId);
  }
);

export const cronTools: Tool[] = [cronEchoTool, cronScheduleTool, cronListTool, cronDeleteTool];
