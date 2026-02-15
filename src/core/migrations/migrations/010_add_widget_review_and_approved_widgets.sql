-- Widget review requests: when an agent submits custom HTML/CSS/JS for a dashboard widget,
-- a request is stored for Maia/user security review. Status flow: pending -> approved | denied.

CREATE TABLE IF NOT EXISTS widget_review_requests (
  id TEXT PRIMARY KEY,
  requesting_agent_id TEXT NOT NULL,
  widget_id TEXT NOT NULL,
  name TEXT,
  html TEXT NOT NULL,
  css TEXT NOT NULL,
  js TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_widget_review_requests_status ON widget_review_requests(status);
CREATE INDEX IF NOT EXISTS idx_widget_review_requests_requesting_agent ON widget_review_requests(requesting_agent_id);

-- Approved dashboard widgets: only approved widgets are stored and rendered in the dashboard.
-- Populated when a widget_review_request is approved.

CREATE TABLE IF NOT EXISTS approved_dashboard_widgets (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  widget_id TEXT NOT NULL,
  name TEXT,
  html TEXT NOT NULL,
  css TEXT NOT NULL,
  js TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, widget_id)
);

CREATE INDEX IF NOT EXISTS idx_approved_dashboard_widgets_agent_id ON approved_dashboard_widgets(agent_id);
