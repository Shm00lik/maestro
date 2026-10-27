CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  state TEXT NOT NULL,
  depth TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  mission_branch TEXT NOT NULL,
  isolation TEXT NOT NULL,
  max_parallel INTEGER NOT NULL,
  conductor_session_id TEXT,
  settings_json TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS plan_versions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  version INTEGER NOT NULL,
  plan_path TEXT NOT NULL,
  plan_md TEXT NOT NULL,
  approved_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id),
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  owns_json TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  depth INTEGER NOT NULL,
  on_critical_path INTEGER NOT NULL,
  session_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  handoff_md TEXT,
  failure_reason TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  answer_json TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  snoozed_until INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT REFERENCES tasks(id),
  role TEXT NOT NULL,
  claude_session_id TEXT,
  pid INTEGER,
  state TEXT NOT NULL,
  log_path TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT REFERENCES tasks(id),
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id);
CREATE INDEX IF NOT EXISTS idx_inbox_mission ON inbox(mission_id, state);
CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id, id);
