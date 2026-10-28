import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { PlanTask } from '../core/types.js';
import type { PlanGraph } from '../core/plan/graph.js';
import { nextTaskState, type TaskState, type TaskEvent } from '../core/state/taskMachine.js';
import { nextMissionState, type MissionState, type MissionEvent } from '../core/state/missionMachine.js';

const TASK_STATES: readonly string[] = ['waiting', 'ready', 'running', 'needs_you', 'done', 'failed', 'cancelled'];
const MISSION_STATES: readonly string[] = [
  'draft', 'understanding', 'planning', 'awaiting_approval', 'running', 'paused', 'finishing', 'done', 'stopped', 'failed',
];

function checkState<T extends string>(kind: string, known: readonly string[], v: string): T {
  if (!known.includes(v)) throw new Error(`Unknown ${kind} state in database: "${v}"`);
  return v as T;
}

/** Thrown by inbox.answer when the entry has already been answered. */
export class AlreadyAnswered extends Error {
  constructor(public id: string) {
    super(`Inbox entry already answered: ${id}`);
    this.name = 'AlreadyAnswered';
  }
}

export interface Project { id: string; name: string; path: string; createdAt: number; lastUsedAt: number }

export interface NewMission {
  projectId: string; title: string; brief: string; depth: 'quick' | 'thorough';
  baseBranch: string; missionBranch: string; isolation: 'worktree' | 'in_place'; maxParallel: number;
  settings?: unknown;
}
export interface Mission extends Omit<NewMission, 'settings'> {
  id: string; state: MissionState; conductorSessionId: string | null; settings: unknown;
  createdAt: number; endedAt: number | null;
}

export interface Task {
  id: string; missionId: string; planVersionId: string; taskKey: string; title: string; agent: string;
  prompt: string; state: TaskState; dependsOn: string[]; owns: string[]; acceptance: string;
  depth: number; onCriticalPath: boolean; sessionId: string | null; worktreePath: string | null;
  branch: string | null; handoffMd: string | null; failureReason: string | null;
  startedAt: number | null; endedAt: number | null; tokensIn: number; tokensOut: number;
}

export type InboxKind = 'question' | 'plan_approval' | 'permission' | 'review_decision' | 'merge_decision';
export interface NewInboxEntry {
  missionId: string; taskId?: string | null; kind: InboxKind; payload: unknown; snoozedUntil?: number | null;
}
export interface InboxEntry {
  id: string; missionId: string; taskId: string | null; kind: InboxKind; payload: unknown;
  state: 'open' | 'answered'; answer: unknown; createdAt: number; answeredAt: number | null; snoozedUntil: number | null;
}

export interface NewEvent { missionId: string; taskId?: string | null; type: string; data: unknown; ts?: number }
export interface EventRow { id: number; missionId: string; taskId: string | null; ts: number; type: string; data: any }

type Row = Record<string, any>;
const parse = (s: string | null): any => (s == null ? null : JSON.parse(s));

const toProject = (r: Row): Project => ({
  id: r.id, name: r.name, path: r.path, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});
const toMission = (r: Row): Mission => ({
  id: r.id, projectId: r.project_id, title: r.title, brief: r.brief, state: r.state, depth: r.depth,
  baseBranch: r.base_branch, missionBranch: r.mission_branch, isolation: r.isolation, maxParallel: r.max_parallel,
  conductorSessionId: r.conductor_session_id, settings: parse(r.settings_json),
  createdAt: r.created_at, endedAt: r.ended_at,
});
const toTask = (r: Row): Task => ({
  id: r.id, missionId: r.mission_id, planVersionId: r.plan_version_id, taskKey: r.task_key, title: r.title,
  agent: r.agent, prompt: r.prompt, state: r.state, dependsOn: parse(r.depends_on_json), owns: parse(r.owns_json),
  acceptance: r.acceptance, depth: r.depth, onCriticalPath: r.on_critical_path === 1, sessionId: r.session_id,
  worktreePath: r.worktree_path, branch: r.branch, handoffMd: r.handoff_md, failureReason: r.failure_reason,
  startedAt: r.started_at, endedAt: r.ended_at, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
});
const toInbox = (r: Row): InboxEntry => ({
  id: r.id, missionId: r.mission_id, taskId: r.task_id, kind: r.kind, payload: parse(r.payload_json),
  state: r.state, answer: parse(r.answer_json), createdAt: r.created_at, answeredAt: r.answered_at,
  snoozedUntil: r.snoozed_until,
});
const toEvent = (r: Row): EventRow => ({
  id: r.id, missionId: r.mission_id, taskId: r.task_id, ts: r.ts, type: r.type, data: parse(r.data_json),
});

function appendEvent(db: Db, e: NewEvent): void {
  db.prepare('INSERT INTO events (mission_id, task_id, ts, type, data_json) VALUES (?,?,?,?,?)')
    .run(e.missionId, e.taskId ?? null, e.ts ?? Date.now(), e.type, JSON.stringify(e.data ?? null));
}

export const projects = {
  add(db: Db, p: { name: string; path: string }): Project {
    const now = Date.now();
    const id = randomUUID();
    db.prepare('INSERT INTO projects (id, name, path, created_at, last_used_at) VALUES (?,?,?,?,?)')
      .run(id, p.name, p.path, now, now);
    return toProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row);
  },
  list(db: Db): Project[] {
    return (db.prepare('SELECT * FROM projects ORDER BY created_at, rowid').all() as Row[]).map(toProject);
  },
};

export const missions = {
  create(db: Db, m: NewMission): Mission {
    const id = randomUUID();
    db.prepare(`INSERT INTO missions (id, project_id, title, brief, state, depth, base_branch, mission_branch,
      isolation, max_parallel, settings_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, m.projectId, m.title, m.brief, 'draft', m.depth, m.baseBranch, m.missionBranch,
        m.isolation, m.maxParallel, m.settings === undefined ? null : JSON.stringify(m.settings), Date.now());
    return missions.get(db, id)!;
  },
  get(db: Db, id: string): Mission | undefined {
    const r = db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as Row | undefined;
    return r && toMission(r);
  },
  transition(db: Db, id: string, ev: MissionEvent): Mission {
    return db.transaction(() => {
      const r = db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as Row | undefined;
      if (!r) throw new Error(`Mission not found: ${id}`);
      const from = checkState<MissionState>('mission', MISSION_STATES, r.state);
      const to = nextMissionState(from, ev);
      const ended = ['done', 'stopped', 'failed'].includes(to) ? Date.now() : null;
      db.prepare('UPDATE missions SET state = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?').run(to, ended, id);
      appendEvent(db, { missionId: id, type: 'state', data: { from, to, event: ev } });
      return missions.get(db, id)!;
    })();
  },
};

export const planVersions = {
  create(db: Db, v: { missionId: string; version: number; planPath: string; planMd: string }): { id: string } {
    const id = randomUUID();
    db.prepare('INSERT INTO plan_versions (id, mission_id, version, plan_path, plan_md) VALUES (?,?,?,?,?)')
      .run(id, v.missionId, v.version, v.planPath, v.planMd);
    return { id };
  },
  approve(db: Db, id: string): void {
    const res = db.prepare('UPDATE plan_versions SET approved_at = ? WHERE id = ?').run(Date.now(), id);
    if (res.changes === 0) throw new Error(`Plan version not found: ${id}`);
  },
};

export const tasks = {
  insertPlan(db: Db, missionId: string, planVersionId: string, planTasks: PlanTask[], graph: PlanGraph): Task[] {
    const critical = new Set(graph.criticalPath);
    const ins = db.prepare(`INSERT INTO tasks (id, mission_id, plan_version_id, task_key, title, agent, prompt, state,
      depends_on_json, owns_json, acceptance, depth, on_critical_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    return db.transaction(() => {
      const ids: string[] = [];
      for (const t of planTasks) {
        const id = randomUUID();
        ids.push(id);
        ins.run(id, missionId, planVersionId, t.key, t.title, t.agent, t.body, 'waiting',
          JSON.stringify(t.dependsOn), JSON.stringify(t.owns), t.acceptance,
          graph.depth[t.key] ?? 0, critical.has(t.key) ? 1 : 0);
      }
      return ids.map(id => toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row));
    })();
  },
  transition(db: Db, id: string, ev: TaskEvent): Task {
    return db.transaction(() => {
      const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
      if (!r) throw new Error(`Task not found: ${id}`);
      const from = checkState<TaskState>('task', TASK_STATES, r.state);
      const to = nextTaskState(from, ev);
      // started_at: set on start. ended_at: set on entering done/failed/cancelled, cleared on retry.
      const now = Date.now();
      const started = ev === 'start' ? now : null;
      const ended = to === 'done' || to === 'failed' || to === 'cancelled' ? now : null;
      db.prepare(`UPDATE tasks SET state = ?, started_at = COALESCE(?, started_at),
        ended_at = CASE WHEN ? THEN NULL ELSE COALESCE(?, ended_at) END WHERE id = ?`)
        .run(to, started, ev === 'retry' ? 1 : 0, ended, id);
      appendEvent(db, { missionId: r.mission_id, taskId: id, type: 'state', data: { from, to, event: ev } });
      return toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row);
    })();
  },
  listByMission(db: Db, missionId: string): Task[] {
    return (db.prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY rowid').all(missionId) as Row[]).map(toTask);
  },
  addUsage(db: Db, id: string, tokensIn: number, tokensOut: number): void {
    const res = db.prepare('UPDATE tasks SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?')
      .run(tokensIn, tokensOut, id);
    if (res.changes === 0) throw new Error(`Task not found: ${id}`);
  },
};

export const inbox = {
  add(db: Db, e: NewInboxEntry): InboxEntry {
    const id = randomUUID();
    db.prepare(`INSERT INTO inbox (id, mission_id, task_id, kind, payload_json, state, created_at, snoozed_until)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, e.missionId, e.taskId ?? null, e.kind, JSON.stringify(e.payload ?? null), 'open', Date.now(), e.snoozedUntil ?? null);
    return toInbox(db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as Row);
  },
  answer(db: Db, id: string, answer: unknown): InboxEntry {
    return db.transaction(() => {
      const res = db.prepare(
        "UPDATE inbox SET state = 'answered', answer_json = ?, answered_at = ? WHERE id = ? AND state = 'open'",
      ).run(JSON.stringify(answer ?? null), Date.now(), id);
      const r = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as Row | undefined;
      if (!r) throw new Error(`Inbox entry not found: ${id}`);
      if (res.changes === 0) throw new AlreadyAnswered(id);
      return toInbox(r);
    })();
  },
  listOpen(db: Db, now: number): InboxEntry[] {
    return (db.prepare(`SELECT * FROM inbox WHERE state = 'open' AND (snoozed_until IS NULL OR snoozed_until <= ?)
      ORDER BY created_at, rowid`).all(now) as Row[]).map(toInbox);
  },
};

export const events = {
  append(db: Db, e: NewEvent): void { appendEvent(db, e); },
  /** Events by id. order 'desc' returns newest first (with limit: the newest N). */
  list(db: Db, missionId: string, opts: { taskId?: string; limit?: number; order?: 'asc' | 'desc' } = {}): EventRow[] {
    let sql = 'SELECT * FROM events WHERE mission_id = ?';
    const args: unknown[] = [missionId];
    if (opts.taskId) { sql += ' AND task_id = ?'; args.push(opts.taskId); }
    sql += opts.order === 'desc' ? ' ORDER BY id DESC' : ' ORDER BY id';
    if (opts.limit) { sql += ' LIMIT ?'; args.push(opts.limit); }
    return (db.prepare(sql).all(...args) as Row[]).map(toEvent);
  },
};
