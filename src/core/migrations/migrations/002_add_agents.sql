-- Add agent support: agent_id column on memories + agents metadata table

-- Add agent_id to memories (defaults to 'maia' for existing rows)
ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'maia';

-- Index for scoped queries
CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id);

-- Agents metadata table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
