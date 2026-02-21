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

export const cronScheduleTool = makeTool(
  "cron_schedule",
  "Schedule a recurring cron job for an agent task. Maia only.",
  z.object({
    expression: z.string().describe("5-field cron expression e.g. '0 9 * * 1'"),
    taskDescription: z.string().describe("Human-readable description of what will happen"),
  }),
  async ({ expression, taskDescription }, ctx) => {
    const id = uuidv4();
    const now = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(id, expression, taskDescription, ctx.agentId, now);
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
    }));
  }
);

export const cronDeleteTool = makeTool(
  "cron_delete",
  "Delete a cron job by ID. Cannot delete built-in jobs. Maia only.",
  z.object({ jobId: z.string() }),
  async ({ jobId }, ctx) => {
    const row = ctx.db.prepare("SELECT is_built_in FROM cron_jobs WHERE id = ?").get(jobId) as { is_built_in: number } | undefined;
    if (!row) throw new Error(`Cron job not found: ${jobId}`);
    if (row.is_built_in) throw new Error("Cannot delete built-in cron jobs");
    ctx.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(jobId);
  }
);

export const cronTools: Tool[] = [cronScheduleTool, cronListTool, cronDeleteTool];
