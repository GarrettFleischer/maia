-- Add conversation threading, message persistence, thread sharing, and pending DMs
-- for the agent dashboard revamp.

-- Conversation threads (user-maia, user-agent, agent-agent, agent-dm, maia-agent-checkin)
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('user-maia', 'user-agent', 'agent-agent', 'agent-dm', 'maia-agent-checkin')),
  title TEXT,
  participants TEXT NOT NULL,  -- JSON array of participant IDs (e.g. ["user","maia","research-bot"])
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_type ON threads(type);
CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at);

-- Messages within threads
CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'maia')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_id ON thread_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_messages_created_at ON thread_messages(created_at);

-- Thread sharing: an agent can share a thread it's part of with another agent
CREATE TABLE IF NOT EXISTS thread_shares (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  shared_with TEXT NOT NULL,
  shared_by TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, shared_with)
);

CREATE INDEX IF NOT EXISTS idx_thread_shares_shared_with ON thread_shares(shared_with);

-- Pending DMs held during quiet time, flushed and merged into a single summary
CREATE TABLE IF NOT EXISTS pending_dms (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  recipient_id TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_pending_dms_recipient_id ON pending_dms(recipient_id);
