-- Initial schema for the agent terminal output stream persistence layer.
-- Stores normalized, scrubbed terminal lines (not raw ANSI PTY chunks).
-- BAPert #10527 approved: raw-line MVP, no structured-event columns.

CREATE TABLE IF NOT EXISTS agent_output_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  terminal_id TEXT NOT NULL,
  provider TEXT,
  line TEXT NOT NULL,
  ts TEXT NOT NULL,        -- ISO-8601 UTC, event timestamp
  created_at TEXT NOT NULL -- ISO-8601 UTC, insert timestamp
);

CREATE INDEX IF NOT EXISTS idx_agent_output_project_ts
  ON agent_output_lines(project_id, ts);

CREATE INDEX IF NOT EXISTS idx_agent_output_project_agent
  ON agent_output_lines(project_id, agent);
