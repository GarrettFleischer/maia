// Server initialization — called once on startup
// Seeds Maia agent record into DB if not already present, and copies default identity files when the agent dir is missing

import path from "path";
import type { AppContext } from "./context";
import { getAgentsDir } from "./data-dir";
import { copyDefaultAgentFiles } from "./tools/agent-management";

export function initMaiaAgent(ctx: AppContext): void {
  const existing = ctx.db.prepare("SELECT id FROM agents WHERE id = 'maia'").get();
  if (existing) return;

  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO agents (id, name, model, status, system_prompt_extra, created_at, updated_at)
     VALUES ('maia', 'Maia', 'ollama/llama3.2', 'active', NULL, ?, ?)`
  ).run(now, now);

  const maiaDir = path.join(getAgentsDir(), "maia");
  if (!ctx.fs.exists(maiaDir)) {
    copyDefaultAgentFiles(ctx, maiaDir, "Maia");
  }

  console.log("Maia agent initialized");
}
