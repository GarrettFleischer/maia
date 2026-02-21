// Server initialization — called once on startup
// Seeds Maia agent record into DB if not already present

import type { AppContext } from "./context";

export function initMaiaAgent(ctx: AppContext): void {
  const existing = ctx.db.prepare("SELECT id FROM agents WHERE id = 'maia'").get();
  if (existing) return;

  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO agents (id, name, model, status, system_prompt_extra, created_at, updated_at)
     VALUES ('maia', 'Maia', 'ollama/llama3.2', 'active', NULL, ?, ?)`
  ).run(now, now);

  console.log("Maia agent initialized");
}
