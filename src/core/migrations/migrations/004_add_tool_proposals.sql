-- Tool proposals (agent-created tools) and check-in security metadata.

-- Proposals: status flow pending_security -> security_denied | pending_user -> user_denied | user_approved
CREATE TABLE IF NOT EXISTS tool_proposals (
  id TEXT PRIMARY KEY,
  proposing_agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  implementation_type TEXT NOT NULL,
  implementation_config_json TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending_security', 'security_denied', 'pending_user', 'user_denied', 'user_approved'
  )),
  security_reason TEXT,
  user_feedback TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_proposals_status ON tool_proposals(status);
CREATE INDEX IF NOT EXISTS idx_tool_proposals_proposing_agent ON tool_proposals(proposing_agent_id);

-- Key-value store for check-in security: last run timestamp (key = 'last_checkin_security_at', value = ISO string)
CREATE TABLE IF NOT EXISTS key_value (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
