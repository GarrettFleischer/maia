import path from "path";
import type { AppContext } from "../context";
import type { AgentDefinition, AgentWithIdentity, ReasoningEffort } from "../types";
import { getAgentsDir } from "../data-dir";

const REASONING_EFFORT_VALUES: ReasoningEffort[] = ["off", "low", "medium", "high"];

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  if (typeof value === "string" && REASONING_EFFORT_VALUES.includes(value as ReasoningEffort)) {
    return value as ReasoningEffort;
  }
  return "medium";
}

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
    reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
    status: row.status as AgentDefinition["status"],
    systemPromptExtra: row.system_prompt_extra as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    soul: read("SOUL.md"),
    memory: read("MEMORY.md"),
    user: read("USER.md"),
    agentsMd: read("AGENTS.md"),
  };
}

export function listAgents(ctx: AppContext): AgentDefinition[] {
  return (
    ctx.db.prepare("SELECT * FROM agents WHERE status != 'deleted' ORDER BY created_at").all() as Record<string, unknown>[]
  ).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    model: r.model as string,
    reasoningEffort: normalizeReasoningEffort(r.reasoning_effort),
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
 * Updates an agent's model, name, and/or reasoningEffort. Does not change id or status.
 * @param ctx - App context
 * @param agentId - Agent id
 * @param partial - Fields to update (model, name, and/or reasoningEffort)
 * @returns true if the agent existed and was updated, false if not found
 * @note Caller must ensure model is whitelisted before calling.
 */
export function updateAgent(
  ctx: AppContext,
  agentId: string,
  partial: { model?: string; name?: string; reasoningEffort?: ReasoningEffort }
): boolean {
  const row = ctx.db
    .prepare("SELECT model, name, reasoning_effort FROM agents WHERE id = ? AND status != 'deleted'")
    .get(agentId) as { model: string; name: string; reasoning_effort?: string } | undefined;
  if (!row) return false;
  const model = partial.model ?? row.model;
  const name = partial.name ?? row.name;
  const reasoningEffort =
    partial.reasoningEffort !== undefined
      ? (REASONING_EFFORT_VALUES.includes(partial.reasoningEffort) ? partial.reasoningEffort : "medium")
      : (row.reasoning_effort && REASONING_EFFORT_VALUES.includes(row.reasoning_effort as ReasoningEffort)
        ? row.reasoning_effort
        : "medium");
  const now = new Date().toISOString();
  ctx.db
    .prepare("UPDATE agents SET model = ?, name = ?, reasoning_effort = ?, updated_at = ? WHERE id = ?")
    .run(model, name, reasoningEffort, now, agentId);
  return true;
}
