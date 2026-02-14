-- Agent creation requests: when a non-Maia agent calls create_agent, a request is stored
-- for Maia/user approval. Status flow: pending -> approved | denied.

CREATE TABLE IF NOT EXISTS agent_creation_requests (
  id TEXT PRIMARY KEY,
  requesting_agent_id TEXT NOT NULL,
  proposed_config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_creation_requests_status ON agent_creation_requests(status);
CREATE INDEX IF NOT EXISTS idx_agent_creation_requests_requesting_agent ON agent_creation_requests(requesting_agent_id);
