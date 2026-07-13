import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { DbAdapter } from "./context";
import { getDataDir, getToolsDir, getUserDir } from "./data-dir";

const DB_PATH = path.join(getDataDir(), "maia.db");

fs.mkdirSync(getDataDir(), { recursive: true });
fs.mkdirSync(getToolsDir(), { recursive: true });
fs.mkdirSync(getUserDir(), { recursive: true });

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
      resolved_content TEXT,
      round_index INTEGER,
      tool_name TEXT,
      tool_args TEXT,
      timestamp TEXT NOT NULL,
      is_compressed INTEGER NOT NULL DEFAULT 0,
      speaker_id TEXT,
      speaker_label TEXT,
      persona_id TEXT
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
      tool_args TEXT NOT NULL DEFAULT '{}',
      persona_id TEXT,
      persona_model TEXT,
      cron_message TEXT
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

    /* Semantic memory: embedded markdown files (knowledge) and history entry chunks. */
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

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    INSERT OR IGNORE INTO active_session (singleton, session_id) VALUES (1, NULL);
  `);

  // Seed schema_version only when empty (new DB); otherwise runMigrations uses existing version
  const hasVersionRow = db
    .prepare("SELECT 1 FROM schema_version LIMIT 1")
    .get();
  if (!hasVersionRow) {
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (0, datetime('now'))",
    ).run();
  }

  runMigrations(db);

  // Seed default settings if not present (whitelisted models live in data/models.json)
  seedSettings(db);

  function runMigrations(database: DbAdapter): void {
    const row = database
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;
    let currentVersion = row?.version ?? 0;

    // Step 1: cron_jobs tool_name / tool_args
    if (currentVersion < 1) {
      const tableInfo = database
        .prepare("PRAGMA table_info(cron_jobs)")
        .all() as { name: string }[];
      const hasToolName = tableInfo.some((c) => c.name === "tool_name");
      const hasToolArgs = tableInfo.some((c) => c.name === "tool_args");
      if (!hasToolName) {
        database.exec(
          "ALTER TABLE cron_jobs ADD COLUMN tool_name TEXT NOT NULL DEFAULT 'cron_echo'",
        );
      }
      if (!hasToolArgs) {
        database.exec(
          "ALTER TABLE cron_jobs ADD COLUMN tool_args TEXT NOT NULL DEFAULT '{}'",
        );
        database.exec(
          "UPDATE cron_jobs SET tool_args = json_object('message', task_description) WHERE tool_args = '{}'",
        );
      }
      database
        .prepare(
          "UPDATE schema_version SET version = 1, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 1;
    }

    // Step 2: agents reasoning_effort
    if (currentVersion < 2) {
      const agentsInfo = database
        .prepare("PRAGMA table_info(agents)")
        .all() as { name: string }[];
      if (!agentsInfo.some((c) => c.name === "reasoning_effort")) {
        database.exec(
          "ALTER TABLE agents ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'",
        );
      }
      database
        .prepare(
          "UPDATE schema_version SET version = 2, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 2;
    }

    // Step 3: history_entries resolved_content and round_index
    if (currentVersion < 3) {
      const historyInfo = database
        .prepare("PRAGMA table_info(history_entries)")
        .all() as {
        name: string;
      }[];
      if (!historyInfo.some((c) => c.name === "resolved_content")) {
        database.exec(
          "ALTER TABLE history_entries ADD COLUMN resolved_content TEXT",
        );
      }
      if (!historyInfo.some((c) => c.name === "round_index")) {
        database.exec(
          "ALTER TABLE history_entries ADD COLUMN round_index INTEGER",
        );
      }
      database
        .prepare(
          "UPDATE schema_version SET version = 3, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 3;
    }

    // Step 4: sessions smart context (single object per run for bubble persistence)
    if (currentVersion < 4) {
      const sessionsInfo = database
        .prepare("PRAGMA table_info(sessions)")
        .all() as { name: string }[];
      if (!sessionsInfo.some((c) => c.name === "smart_context_run")) {
        database.exec("ALTER TABLE sessions ADD COLUMN smart_context_run TEXT");
      }
      if (
        !sessionsInfo.some(
          (c) => c.name === "smart_context_after_message_index",
        )
      ) {
        database.exec(
          "ALTER TABLE sessions ADD COLUMN smart_context_after_message_index INTEGER",
        );
      }
      database
        .prepare(
          "UPDATE schema_version SET version = 4, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 4;
    }

    // Step 5: sessions smart_context_runs (array of { afterMessageIndex, run } per round)
    if (currentVersion < 5) {
      const sessionsInfo = database
        .prepare("PRAGMA table_info(sessions)")
        .all() as { name: string }[];
      if (!sessionsInfo.some((c) => c.name === "smart_context_runs")) {
        database.exec(
          "ALTER TABLE sessions ADD COLUMN smart_context_runs TEXT",
        );
      }
      const rows = database
        .prepare(
          "SELECT id, smart_context_run, smart_context_after_message_index FROM sessions WHERE smart_context_run IS NOT NULL AND smart_context_run != ''",
        )
        .all() as Array<{
        id: string;
        smart_context_run: string;
        smart_context_after_message_index: number | null;
      }>;
      const updateStmt = database.prepare(
        "UPDATE sessions SET smart_context_runs = ?, updated_at = datetime('now') WHERE id = ?",
      );
      for (const row of rows) {
        const afterMessageIndex =
          typeof row.smart_context_after_message_index === "number"
            ? row.smart_context_after_message_index
            : 0;
        try {
          const run = JSON.parse(row.smart_context_run) as {
            phases?: unknown[];
            doneDetail?: string;
            fullPrompt?: string;
          };
          const entry = { afterMessageIndex, run };
          updateStmt.run(JSON.stringify([entry]), row.id);
        } catch {
          // Skip malformed JSON
        }
      }
      database
        .prepare(
          "UPDATE schema_version SET version = 5, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 5;
    }

    // Step 6: history_entries speaker attribution (unified multi-persona transcript)
    if (currentVersion < 6) {
      const historyInfo = database
        .prepare("PRAGMA table_info(history_entries)")
        .all() as { name: string }[];
      if (!historyInfo.some((c) => c.name === "speaker_id")) {
        database.exec("ALTER TABLE history_entries ADD COLUMN speaker_id TEXT");
      }
      if (!historyInfo.some((c) => c.name === "speaker_label")) {
        database.exec(
          "ALTER TABLE history_entries ADD COLUMN speaker_label TEXT",
        );
      }
      if (!historyInfo.some((c) => c.name === "persona_id")) {
        database.exec("ALTER TABLE history_entries ADD COLUMN persona_id TEXT");
      }
      database
        .prepare(
          "UPDATE schema_version SET version = 6, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 6;
    }

    // Step 7: remove MuninnDB settings keys (semantic memory is SQLite-only)
    if (currentVersion < 7) {
      database.exec(
        "DELETE FROM settings WHERE key IN ('muninnUrl', 'muninnApiKey')",
      );
      database
        .prepare(
          "UPDATE schema_version SET version = 7, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 7;
    }

    // Step 8: layered memory (registry, graph episodes, compactions)
    if (currentVersion < 8) {
      database.exec(`
    CREATE TABLE IF NOT EXISTS memory_registry (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      quality_score REAL NOT NULL DEFAULT 1.0,
      source_kind TEXT NOT NULL DEFAULT 'explicit',
      dedupe_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      accessed_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_memory_registry_agent ON memory_registry(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_registry_dedupe ON memory_registry(agent_id, dedupe_hash);

    CREATE TABLE IF NOT EXISTS memory_episodes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      entry_ids_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      accessed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_agent ON memory_episodes(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_session ON memory_episodes(session_id);

    CREATE TABLE IF NOT EXISTS memory_entities (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'entity',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_agent ON memory_entities(agent_id);

    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_edges_agent ON memory_edges(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_id);

    CREATE TABLE IF NOT EXISTS session_compactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      summary_markdown TEXT NOT NULL,
      source_entry_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_compactions_session ON session_compactions(session_id);
      `);
      database
        .prepare(
          "UPDATE schema_version SET version = 8, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 8;
    }

    // Step 9: cron_jobs delegated persona + prompt wake columns
    if (currentVersion < 9) {
      const cronInfo = database
        .prepare("PRAGMA table_info(cron_jobs)")
        .all() as { name: string }[];
      if (!cronInfo.some((c) => c.name === "persona_id")) {
        database.exec("ALTER TABLE cron_jobs ADD COLUMN persona_id TEXT");
      }
      if (!cronInfo.some((c) => c.name === "persona_model")) {
        database.exec("ALTER TABLE cron_jobs ADD COLUMN persona_model TEXT");
      }
      if (!cronInfo.some((c) => c.name === "cron_message")) {
        database.exec("ALTER TABLE cron_jobs ADD COLUMN cron_message TEXT");
      }
      database
        .prepare(
          "UPDATE schema_version SET version = 9, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 9;
    }

    // Step 10: sessions.default_persona_id — optional catalog persona for plain user turns (Maia threads)
    if (currentVersion < 10) {
      const sessionsInfo = database
        .prepare("PRAGMA table_info(sessions)")
        .all() as { name: string }[];
      if (!sessionsInfo.some((c) => c.name === "default_persona_id")) {
        database.exec("ALTER TABLE sessions ADD COLUMN default_persona_id TEXT");
      }
      database
        .prepare(
          "UPDATE schema_version SET version = 10, applied_at = datetime('now')",
        )
        .run();
      currentVersion = 10;
    }
  }

  function seedSettings(database: DbAdapter): void {
    const defaults: Record<string, string> = {
      heartbeatIntervalMinutes: "30",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaApiKey: "",
      openRouterApiKey: "",
      embeddingModel: "ollama/nomic-embed-text",
      embedMaxContentLength: "8192",
      contextQueryModel: "",
      contextRecentTurns: "3",
      contextReasoningEffort: "medium",
      archiveDurationValue: "0",
      archiveDurationUnit: "days",
    };
    const insert = database.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
    );
    for (const [key, value] of Object.entries(defaults)) {
      insert.run(key, value);
    }
  }
}
