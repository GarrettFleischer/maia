import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { DbAdapter } from "./context";
import { getDataDir, getToolsDir } from "./data-dir";

const DB_PATH = path.join(getDataDir(), "maia.db");

fs.mkdirSync(getDataDir(), { recursive: true });
fs.mkdirSync(getToolsDir(), { recursive: true });

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
      created_at TEXT NOT NULL,
      tool_name TEXT NOT NULL DEFAULT 'cron_echo',
      tool_args TEXT NOT NULL DEFAULT '{}'
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

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      created_by TEXT NOT NULL,
      assigned_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);

    CREATE TABLE IF NOT EXISTS approved_tools (
      tool_slug TEXT PRIMARY KEY,
      approved_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO active_session (singleton, session_id) VALUES (1, NULL);
  `);

  // Migration: add tool_name / tool_args to cron_jobs if missing (e.g. existing DBs created before cron-tool change)
  const tableInfo = db.prepare("PRAGMA table_info(cron_jobs)").all() as { name: string }[];
  const hasToolName = tableInfo.some((c) => c.name === "tool_name");
  const hasToolArgs = tableInfo.some((c) => c.name === "tool_args");
  if (!hasToolName) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN tool_name TEXT NOT NULL DEFAULT 'cron_echo'");
  }
  if (!hasToolArgs) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN tool_args TEXT NOT NULL DEFAULT '{}'");
    // Backfill legacy rows so they call cron_echo with task_description as message
    db.exec(
      "UPDATE cron_jobs SET tool_args = json_object('message', task_description) WHERE tool_args = '{}'"
    );
  }

  // Seed built-in heartbeat cron job (after migration so tool_name/tool_args exist on older DBs)
  db.prepare(
    `INSERT OR IGNORE INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args)
     VALUES ('builtin-heartbeat', '*/30 * * * *', 'Heartbeat', 'maia', 1, datetime('now'), 'cron_echo', '{}')`
  ).run();

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
    ollamaApiKey: "",
    openRouterApiKey: "",
    vllmBaseUrl: "http://localhost:8000/v1",
    dockerBaseUrl: "http://localhost:8000/v1",
    embeddingModel: "nomic-embed-text",
    embedMaxContentLength: "4000",
    recentFullCount: "10",
    compressionBatchSize: "5",
  };

  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(key, value);
  }
}
