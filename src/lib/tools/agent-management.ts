import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { zodToJsonSchema } from "../zod-to-json";
import { getSettings } from "../settings";
import { getAgentsDir, getDefaultAgentDir, getDefaultMaiaDir } from "../data-dir";
import { syncAgentRunJobs, reconcileAgentRunTasks } from "../cron/service";
import type { Tool, ToolContext } from "./types";
import type { AgentDefinition } from "../types";
import type { AppContext } from "../context";
import { normalizeReasoningEffort } from "../agent/identity";

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
  user: z.string().optional(),
  systemPromptExtra: z.string().optional(),
});

/** Inline fallbacks when defaults/agent file is missing (e.g. in tests). */
const FALLBACK_SOUL = "# Soul\n\nI am {{name}}, a helpful AI agent.\n";
const FALLBACK_MEMORY = "# Memory\n\nNo memories yet.\n";
const FALLBACK_USER = "# User\n\nNo user information yet.\n";
const FALLBACK_AGENTS_MD = "# How you function\n\nFollow AGENTS.md from project root or defaults/agent. Copy the full system command there into this file for a complete prompt.\n";

/**
 * List the whitelisted AI models from settings for use when creating agents.
 * @brief Returns whitelisted models so Maia can pick one for agent_create.
 * @note Call before agent_create; the model parameter must be in this list.
 */
export const settingsListWhitelistedModelsTool = makeTool(
  "settings_list_whitelisted_models",
  "List the whitelisted AI models from settings. Call this before creating an agent so you can pick the model parameter from this list; agent_create fails if the model is not whitelisted. Maia only.",
  z.object({}),
  async (_args, ctx) => {
    const settings = getSettings(ctx);
    return { whitelistedModels: settings.whitelistedModels };
  }
);

/**
 * Reads a default agent template file from defaults/agent.
 * @param ctx - App context (uses ctx.fs)
 * @param filename - e.g. "SOUL.md"
 * @param fallback - Used when file is missing or unreadable
 * @returns File content or fallback
 */
function readDefaultAgentFile(ctx: AppContext, filename: string, fallback: string): string {
  const filePath = path.join(getDefaultAgentDir(), filename);
  try {
    const raw = ctx.fs.readFile(filePath);
    const s = typeof raw === "string" ? raw.trim() : "";
    return s !== "" ? s : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Reads a default identity file (SOUL, MEMORY, USER). When agentId is "maia", reads from defaults/maia first; otherwise (or if missing) from defaults/agent.
 * @param ctx - App context (uses ctx.fs)
 * @param filename - e.g. "SOUL.md", "MEMORY.md", "USER.md"
 * @param fallback - Used when file is missing or unreadable in both locations
 * @param agentId - When "maia", use defaults/maia first
 * @returns File content or fallback
 */
function readDefaultIdentityFile(
  ctx: AppContext,
  filename: string,
  fallback: string,
  agentId?: string,
): string {
  if (agentId === "maia") {
    try {
      const maiaPath = path.join(getDefaultMaiaDir(), filename);
      const raw = ctx.fs.readFile(maiaPath);
      const s = typeof raw === "string" ? raw.trim() : "";
      if (s !== "") return s;
    } catch {
      // fall through to defaults/agent
    }
  }
  return readDefaultAgentFile(ctx, filename, fallback);
}

/**
 * Reads AGENTS.md default for the given agent. Maia gets content from defaults/maia/AGENTS.md when present; others (and fallback) use defaults/agent/AGENTS.md.
 * @param ctx - App context (uses ctx.fs)
 * @param agentId - Optional agent id; when "maia", use defaults/maia/AGENTS.md first
 * @returns AGENTS.md content or fallback
 */
function readDefaultAgentsMd(ctx: AppContext, agentId?: string): string {
  if (agentId === "maia") {
    try {
      const maiaPath = path.join(getDefaultMaiaDir(), "AGENTS.md");
      const raw = ctx.fs.readFile(maiaPath);
      const s = typeof raw === "string" ? raw.trim() : "";
      if (s !== "") return s;
    } catch {
      // fall through to defaults/agent
    }
  }
  return readDefaultAgentFile(ctx, "AGENTS.md", FALLBACK_AGENTS_MD);
}

/**
 * Copies default agent template files into an agent directory. When agentId is "maia", SOUL/MEMORY/USER and AGENTS.md come from defaults/maia when present; otherwise from defaults/agent. Use when creating a new agent or when seeding Maia on first run.
 * @param ctx - App context (uses ctx.fs)
 * @param agentDir - Absolute path to the agent directory (e.g. data/agents/<id>)
 * @param agentName - Used to replace {{name}} in SOUL.md (sub-agents only; Maia template typically has no placeholder)
 * @param agentId - Optional agent id; when "maia", identity files and AGENTS.md are read from defaults/maia when present
 */
export function copyDefaultAgentFiles(
  ctx: AppContext,
  agentDir: string,
  agentName: string,
  agentId?: string
): void {
  ctx.fs.mkdirp(agentDir);
  ctx.fs.mkdirp(path.join(agentDir, "workspace"));
  ctx.fs.mkdirp(path.join(agentDir, "memory"));
  ctx.fs.mkdirp(path.join(agentDir, "user"));
  const soulContent = readDefaultIdentityFile(ctx, "SOUL.md", FALLBACK_SOUL, agentId).replace(/\{\{name\}\}/g, agentName);
  ctx.fs.writeFile(path.join(agentDir, "SOUL.md"), soulContent);
  ctx.fs.writeFile(path.join(agentDir, "MEMORY.md"), readDefaultIdentityFile(ctx, "MEMORY.md", FALLBACK_MEMORY, agentId));
  ctx.fs.writeFile(path.join(agentDir, "USER.md"), readDefaultIdentityFile(ctx, "USER.md", FALLBACK_USER, agentId));
  ctx.fs.writeFile(path.join(agentDir, "AGENTS.md"), readDefaultAgentsMd(ctx, agentId));
}

export const agentCreateTool = makeTool(
  "agent_create",
  "Create a new agent. Use agent_list first to see existing agents and avoid duplicates. Before calling, use settings_list_whitelisted_models to get the allowed models and set the model parameter to one of those; otherwise creation fails. Maia only.",
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

    const agentDir = path.join(getAgentsDir(), id);
    copyDefaultAgentFiles(ctx, agentDir, args.name, id);

    if (args.soul !== undefined) ctx.fs.writeFile(path.join(agentDir, "SOUL.md"), args.soul);
    if (args.memory !== undefined) ctx.fs.writeFile(path.join(agentDir, "MEMORY.md"), args.memory);
    if (args.user !== undefined) ctx.fs.writeFile(path.join(agentDir, "USER.md"), args.user);

    syncAgentRunJobs(ctx);
    reconcileAgentRunTasks(ctx);
    return id;
  }
);

export const agentDeleteTool = makeTool(
  "agent_delete",
  "Delete an agent by ID. Use agent_list first to find the agent ID. Maia only.",
  z.object({ agentId: z.string() }),
  async ({ agentId }, ctx) => {
    ctx.db.prepare("UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), agentId);
    syncAgentRunJobs(ctx);
    reconcileAgentRunTasks(ctx);
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
    const agentDir = path.join(getAgentsDir(), agentId);
    const read = (file: string) => {
      try { return ctx.fs.readFile(path.join(agentDir, file)); } catch { return ""; }
    };
    return { agent: rowToAgent(row), soul: read("SOUL.md"), memory: read("MEMORY.md"), user: read("USER.md"), agentsMd: read("AGENTS.md") };
  }
);

function rowToAgent(r: Record<string, unknown>): AgentDefinition {
  return {
    id: r.id as string,
    name: r.name as string,
    model: r.model as string,
    reasoningEffort: normalizeReasoningEffort(r.reasoning_effort),
    status: r.status as AgentDefinition["status"],
    systemPromptExtra: r.system_prompt_extra as string | undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export const agentManagementTools: Tool[] = [
  settingsListWhitelistedModelsTool,
  agentCreateTool,
  agentDeleteTool,
  agentListTool,
  agentGetTool,
];
