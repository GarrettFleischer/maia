-- Initial database schema for Maia memory system
-- Creates the core memories table with FTS5 full-text search index

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('preference', 'fact', 'decision', 'entity', 'other')),
  importance REAL NOT NULL DEFAULT 0.7,
  embedding BLOB,
  source_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Full-text search index for keyword/BM25 search
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content=memories,
  content_rowid=rowid
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
