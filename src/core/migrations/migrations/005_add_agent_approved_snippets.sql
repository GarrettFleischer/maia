-- User-approved security snippets per agent. Only the user (via dashboard approval_response) can add rows.
-- When an inline security flag matches an approved snippet for that agent, we do not stop the agent or show approval_request again.
CREATE TABLE IF NOT EXISTS agent_approved_snippets (
  agent_id TEXT NOT NULL,
  snippet_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, snippet_hash)
);

CREATE INDEX IF NOT EXISTS idx_agent_approved_snippets_agent ON agent_approved_snippets(agent_id);
