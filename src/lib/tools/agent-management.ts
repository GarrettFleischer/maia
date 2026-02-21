import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { zodToJsonSchema } from "../zod-to-json";
import { getSettings } from "../settings";
import type { Tool, ToolContext } from "./types";
import type { AgentDefinition } from "../types";

const DATA_DIR = path.join(process.cwd(), "data", "agents");

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

const agentCreateSchema = z.object({
  name: z.string(),
  model: z.string(),
  soul: z.string().optional(),
  memory: z.string().optional(),
  goals: z.string().optional(),
  user: z.string().optional(),
  systemPromptExtra: z.string().optional(),
});

export const agentCreateTool = makeTool(
  "agent_create",
  "Create a new agent. Maia only.",
  agentCreateSchema,
  async (args, ctx) => {
    const settings = getSettings(ctx);
    if (!settings.whitelistedModels.includes(args.model)) {
      throw new Error(`Model not whitelisted: ${args.model}`);
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO agents (id, name, model, system_prompt_extra, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).run(id, args.name, args.model, args.systemPromptExtra ?? null, now, now);

    const agentDir = path.join(DATA_DIR, id);
    ctx.fs.mkdirp(agentDir);
    ctx.fs.writeFile(path.join(agentDir, "SOUL.md"), args.soul ?? `# Soul\n\nI am ${args.name}, a helpful AI agent.\n`);
    ctx.fs.writeFile(path.join(agentDir, "MEMORY.md"), args.memory ?? "# Memory\n\nNo memories yet.\n");
    ctx.fs.writeFile(path.join(agentDir, "GOALS.md"), args.goals ?? "# Goals\n\n## Current Tasks\n- [ ] Awaiting instructions\n");
    ctx.fs.writeFile(path.join(agentDir, "USER.md"), args.user ?? "# User\n\nNo user information yet.\n");

    return id;
  }
);

export const agentDeleteTool = makeTool(
  "agent_delete",
  "Delete an agent by ID. Maia only.",
  z.object({ agentId: z.string() }),
  async ({ agentId }, ctx) => {
    ctx.db.prepare("UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), agentId);
  }
);

export const agentListTool = makeTool(
  "agent_list",
  "List all agents. Maia only.",
  z.object({}),
  async (_args, ctx) => {
    return (ctx.db.prepare("SELECT * FROM agents WHERE status != 'deleted' ORDER BY created_at").all() as Record<string, unknown>[]).map(rowToAgent);
  }
);

export const agentGetTool = makeTool(
  "agent_get",
  "Get an agent's definition and identity files. Maia only.",
  z.object({ agentId: z.string() }),
  async ({ agentId }, ctx) => {
    const row = ctx.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const agentDir = path.join(DATA_DIR, agentId);
    const read = (file: string) => {
      try { return ctx.fs.readFile(path.join(agentDir, file)); } catch { return ""; }
    };
    return { agent: rowToAgent(row), soul: read("SOUL.md"), memory: read("MEMORY.md"), goals: read("GOALS.md"), user: read("USER.md") };
  }
);

function rowToAgent(r: Record<string, unknown>): AgentDefinition {
  return {
    id: r.id as string,
    name: r.name as string,
    model: r.model as string,
    status: r.status as AgentDefinition["status"],
    systemPromptExtra: r.system_prompt_extra as string | undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export const agentManagementTools: Tool[] = [agentCreateTool, agentDeleteTool, agentListTool, agentGetTool];
