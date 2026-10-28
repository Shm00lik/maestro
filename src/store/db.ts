import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { normalizePath } from './pathKey.js';

export type Db = Database.Database;

/**
 * Ordered schema migrations. Migration i (0-based) moves the db from user_version i to i + 1.
 * Never edit a shipped migration; append a new one instead.
 */

/** Migration 2 (Plan 2): rebuilds projects/missions/tasks/inbox (SQLite cannot alter CHECK/UNIQUE) and adds new tables. */
const MIGRATION_2 = `
CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
INSERT INTO projects_new (id, name, path, path_key, created_at, last_used_at)
  SELECT id, name, path, id, created_at, last_used_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE TABLE missions_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft','understanding','planning','awaiting_approval','running',
    'finishing','done','stopped','failed')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('merged','kept')),
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
INSERT INTO missions_new (id, project_id, title, brief, state, outcome, depth, base_branch, mission_branch,
    isolation, max_parallel, conductor_session_id, settings_json, created_at, ended_at)
  SELECT id, project_id, title, brief, CASE state WHEN 'paused' THEN 'running' ELSE state END, NULL, depth,
    base_branch, mission_branch, isolation, max_parallel, conductor_session_id, settings_json, created_at, ended_at
  FROM missions;
DROP TABLE missions;
ALTER TABLE missions_new RENAME TO missions;

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  plan_version_id TEXT REFERENCES plan_versions(id),
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  plan_body TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned','waiting','ready','running','needs_you','done','failed','cancelled')),
  depends_on_json TEXT NOT NULL,
  owns_json TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  depth INTEGER NOT NULL,
  on_critical_path INTEGER NOT NULL,
  dispatched_at INTEGER,
  session_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  handoff_md TEXT,
  failure_reason TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  UNIQUE (mission_id, task_key)
);
INSERT INTO tasks_new (id, mission_id, plan_version_id, task_key, title, agent, prompt, plan_body, state,
    depends_on_json, owns_json, acceptance, depth, on_critical_path, dispatched_at, session_id, worktree_path,
    branch, handoff_md, failure_reason, started_at, ended_at, tokens_in, tokens_out)
  SELECT id, mission_id, plan_version_id, task_key, title, agent, prompt, prompt, state,
    depends_on_json, owns_json, acceptance, depth, on_critical_path, NULL, session_id, worktree_path,
    branch, handoff_md, failure_reason, started_at, ended_at, tokens_in, tokens_out
  FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_mission ON tasks(mission_id);

CREATE TABLE inbox_new (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('question','plan_approval','permission','review_decision','merge_decision')),
  request_id TEXT,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','answered','expired')),
  answer_json TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  snoozed_until INTEGER
);
INSERT INTO inbox_new (id, mission_id, task_id, kind, request_id, payload_json, state, answer_json, created_at,
    answered_at, snoozed_until)
  SELECT id, mission_id, task_id, kind, NULL, payload_json, state, answer_json, created_at, answered_at, snoozed_until
  FROM inbox;
DROP TABLE inbox;
ALTER TABLE inbox_new RENAME TO inbox;
CREATE INDEX idx_inbox_mission ON inbox(mission_id, state);
CREATE INDEX idx_inbox_request ON inbox(request_id);

CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  tool_name TEXT NOT NULL,
  input_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_permission_rules_mission ON permission_rules(mission_id);
CREATE TABLE usage_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  five_hour_utilization REAL,
  five_hour_resets_at INTEGER,
  seven_day_utilization REAL,
  seven_day_resets_at INTEGER,
  seen_at INTEGER NOT NULL
);
`;

/** Migration 3 (Plan 2 recovery): stuck detection reads each running task's latest event. */
const MIGRATION_3 = `CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, ts);`;

export const MIGRATIONS: readonly string[] = [
  readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'), // 1: baseline
  MIGRATION_2, // 2: Plan 2 engine
  MIGRATION_3, // 3: events by task
];

/** Pre-flight for migration 2: fail with a readable message instead of a raw UNIQUE error. */
function precheckMigration2(db: Db): void {
  const seen = new Map<string, string[]>();
  for (const r of db.prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[]) {
    const k = normalizePath(r.path);
    seen.set(k, [...(seen.get(k) ?? []), `${r.id} (${r.path})`]);
  }
  for (const [k, rows] of seen) {
    if (rows.length > 1) {
      throw new Error(`Migration 2 blocked: projects share the normalised path "${k}": ${rows.join(', ')}. ` +
        'Delete or re-path all but one of these projects, then reopen.');
    }
  }
  const dups = db.prepare('SELECT mission_id, task_key, COUNT(*) AS n FROM tasks GROUP BY mission_id, task_key HAVING n > 1')
    .all() as { mission_id: string; task_key: string; n: number }[];
  if (dups.length > 0) {
    throw new Error('Migration 2 blocked: duplicate task keys within a mission across plan versions: ' +
      dups.map(d => `mission ${d.mission_id} key ${d.task_key} (x${d.n})`).join(', ') +
      '. Delete the stale duplicate task rows (keep one per key), then reopen.');
  }
}

function backfillPathKeys(db: Db): void {
  const upd = db.prepare('UPDATE projects SET path_key = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[]) {
    upd.run(normalizePath(r.path), r.id);
  }
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this build supports (${MIGRATIONS.length}).`);
  }
  if (current === MIGRATIONS.length) return;
  // foreign_keys cannot change inside a transaction; table rebuilds need it off.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (let i = current; i < MIGRATIONS.length; i++) {
        if (i === 1) precheckMigration2(db);
        db.exec(MIGRATIONS[i]);
        if (i === 1) backfillPathKeys(db);
      }
      const bad = db.pragma('foreign_key_check') as unknown[];
      if (bad.length > 0) throw new Error(`Migration left ${bad.length} foreign key violation(s)`);
      db.pragma(`user_version = ${MIGRATIONS.length}`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export function openDb(file: string): Db {
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON');
    if (file !== ':memory:') db.pragma('journal_mode = WAL');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
