-- LLM call history for audit and per-thread prompt/response view.
-- Stores each LLM request/response round (Maia and sub-agents) with optional thread association.

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT,
  request_messages TEXT NOT NULL,
  response_content TEXT NOT NULL,
  response_tool_calls TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_agent_id ON llm_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_thread_id ON llm_calls(thread_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created_at ON llm_calls(created_at);
