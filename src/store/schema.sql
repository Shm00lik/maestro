-- Migration 1: baseline schema. Applied once by openDb (see MIGRATIONS in db.ts).
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','understanding','planning','awaiting_approval','running',
    'paused','finishing','done','stopped','failed')),
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
CREATE TABLE plan_versions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  version INTEGER NOT NULL,
  plan_path TEXT NOT NULL,
  plan_md TEXT NOT NULL,
  approved_at INTEGER,
  UNIQUE (mission_id, version)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  plan_version_id TEXT NOT NULL REFERENCES plan_versions(id),
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting','ready','running','needs_you','done','failed','cancelled')),
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
  tokens_out INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_version_id, task_key)
);
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('question','plan_approval','permission','review_decision','merge_decision')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','answered')),
  answer_json TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  snoozed_until INTEGER
);
CREATE TABLE sessions (
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
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT REFERENCES tasks(id),
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX idx_tasks_mission ON tasks(mission_id);
CREATE INDEX idx_inbox_mission ON inbox(mission_id, state);
CREATE INDEX idx_events_mission ON events(mission_id, id);
