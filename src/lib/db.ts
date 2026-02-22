import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { DbAdapter } from "./context";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "maia.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

let _db: Database.Database | null = null;

export function getDb(): DbAdapter {
  if (_db) return _db as unknown as DbAdapter;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db as unknown as DbAdapter);
  return _db as unknown as DbAdapter;
}

/** Exported so the test helper can reuse the same schema definition. */
export function initSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      participants TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      type TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS history_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_name TEXT,
      tool_args TEXT,
      timestamp TEXT NOT NULL,
      is_compressed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_history_session ON history_entries(session_id, is_compressed);

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      system_prompt_extra TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credentials (
      key TEXT PRIMARY KEY,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      expression TEXT NOT NULL,
      task_description TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      is_built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_session (
      singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK(singleton = 1),
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS knowledge_vectors (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS history_vectors (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      is_compressed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_vectors_session ON history_vectors(session_id);

    INSERT OR IGNORE INTO active_session (singleton, session_id) VALUES (1, NULL);
  `);

  // Seed default settings if not present
  const defaults: Record<string, string> = {
    whitelistedModels: JSON.stringify([
      "ollama/llama3.2",
      "ollama/qwen2.5-coder",
      "openrouter/anthropic/claude-3.5-haiku",
      "openrouter/anthropic/claude-sonnet-4-5",
    ]),
    compressionModel: "ollama/llama3.2",
    heartbeatIntervalMinutes: "30",
    ollamaBaseUrl: "http://localhost:11434",
    openRouterApiKey: "",
    embeddingModel: "nomic-embed-text",
  };

  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, value);
  }
}
