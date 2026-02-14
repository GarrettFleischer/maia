-- MCP server proposals: agents propose MCP servers (e.g. built in sandbox) for Maia/user approval.
-- Status flow: pending_security -> security_denied | pending_user -> user_denied | user_approved.

CREATE TABLE IF NOT EXISTS mcp_server_proposals (
  id TEXT PRIMARY KEY,
  proposing_agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sandbox_path TEXT NOT NULL,
  dockerfile_path TEXT,
  image_ref TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending_security', 'security_denied', 'pending_user', 'user_denied', 'user_approved'
  )),
  security_reason TEXT,
  user_feedback TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_proposals_status ON mcp_server_proposals(status);
CREATE INDEX IF NOT EXISTS idx_mcp_server_proposals_proposing_agent ON mcp_server_proposals(proposing_agent_id);
