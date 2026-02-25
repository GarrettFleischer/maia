import path from "path";
import type { AppContext } from "../context";
import type { AgentDefinition, AgentWithIdentity } from "../types";
import { getAgentsDir } from "../data-dir";

export function getAgentIdentity(ctx: AppContext, agentId: string): AgentWithIdentity | null {
  const row = ctx.db
    .prepare("SELECT * FROM agents WHERE id = ? AND status != 'deleted'")
    .get(agentId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const dir = path.join(getAgentsDir(), agentId);
  const read = (file: string) => {
    try { return ctx.fs.readFile(path.join(dir, file)); } catch { return ""; }
  };

  return {
    id: row.id as string,
    name: row.name as string,
    model: row.model as string,
    status: row.status as AgentDefinition["status"],
    systemPromptExtra: row.system_prompt_extra as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    soul: read("SOUL.md"),
    memory: read("MEMORY.md"),
    goals: read("GOALS.md"),
    user: read("USER.md"),
  };
}

export function listAgents(ctx: AppContext): AgentDefinition[] {
  return (
    ctx.db.prepare("SELECT * FROM agents WHERE status != 'deleted' ORDER BY created_at").all() as Record<string, unknown>[]
  ).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    model: r.model as string,
    status: r.status as AgentDefinition["status"],
    systemPromptExtra: r.system_prompt_extra as string | undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export function setAgentStatus(ctx: AppContext, agentId: string, status: "idle" | "running" | "paused"): void {
  ctx.db.prepare("UPDATE agents SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    new Date().toISOString(),
    agentId
  );
}

/**
 * Updates an agent's model and/or name. Does not change id or status.
 * @param ctx - App context
 * @param agentId - Agent id
 * @param partial - Fields to update (model and/or name)
 * @returns true if the agent existed and was updated, false if not found
 * @note Caller must ensure model is whitelisted before calling.
 */
export function updateAgent(
  ctx: AppContext,
  agentId: string,
  partial: { model?: string; name?: string }
): boolean {
  const row = ctx.db.prepare("SELECT model, name FROM agents WHERE id = ? AND status != 'deleted'").get(agentId) as
    | { model: string; name: string }
    | undefined;
  if (!row) return false;
  const model = partial.model ?? row.model;
  const name = partial.name ?? row.name;
  const now = new Date().toISOString();
  ctx.db.prepare("UPDATE agents SET model = ?, name = ?, updated_at = ? WHERE id = ?").run(model, name, now, agentId);
  return true;
}
