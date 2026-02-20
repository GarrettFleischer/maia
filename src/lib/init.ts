// Server initialization — called once on startup
// Seeds Maia agent record into DB if not already present

import { getDb } from "./db";
import fs from "fs";
import path from "path";

export function initMaiaAgent(): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM agents WHERE id = 'maia'").get();
  if (existing) return;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agents (id, name, model, status, system_prompt_extra, created_at, updated_at)
     VALUES ('maia', 'Maia', 'ollama/llama3.2', 'active', NULL, ?, ?)`
  ).run(now, now);

  console.log("Maia agent initialized");
}
