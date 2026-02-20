import fs from "fs";
import path from "path";
import { getDb } from "../db";
import type { AgentDefinition, AgentWithIdentity } from "../types";

const AGENTS_DIR = path.join(process.cwd(), "data", "agents");

export function getAgentIdentity(agentId: string): AgentWithIdentity | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM agents WHERE id = ? AND status != 'deleted'")
    .get(agentId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const dir = path.join(AGENTS_DIR, agentId);
  const read = (file: string) => {
    try { return fs.readFileSync(path.join(dir, file), "utf8"); } catch { return ""; }
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

export function listAgents(): AgentDefinition[] {
  const db = getDb();
  return (
    db.prepare("SELECT * FROM agents WHERE status != 'deleted' ORDER BY created_at").all() as Record<string, unknown>[]
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

export function setAgentStatus(agentId: string, status: "idle" | "running" | "paused"): void {
  const db = getDb();
  db.prepare("UPDATE agents SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    new Date().toISOString(),
    agentId
  );
}
