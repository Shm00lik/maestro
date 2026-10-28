import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { normalizePath } from './pathKey.js';
import type { PlanTask } from '../core/types.js';
import type { PlanGraph } from '../core/plan/graph.js';
import { nextTaskState, type TaskState, type TaskEvent } from '../core/state/taskMachine.js';
import {
  nextMissionState, type MissionState, type MissionEvent, type MissionOutcome,
} from '../core/state/missionMachine.js';
import type { TokenUsage, UsageWindow } from '../claude/protocol.js';

const TASK_STATES: readonly string[] = ['planned', 'waiting', 'ready', 'running', 'needs_you', 'done', 'failed', 'cancelled'];
const MISSION_STATES: readonly string[] = [
  'draft', 'understanding', 'planning', 'awaiting_approval', 'running', 'finishing', 'done', 'stopped', 'failed',
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

/** Thrown by inbox.answer when the entry expired before it was answered. */
export class Expired extends Error {
  constructor(public id: string) {
    super(`Inbox entry expired: ${id}`);
    this.name = 'Expired';
  }
}

export { normalizePath };

/** Thrown by projects.add when a project with the same normalised path exists. */
export class DuplicateProject extends Error {
  constructor(public path: string) {
    super(`A project with this path already exists: ${path}`);
    this.name = 'DuplicateProject';
  }
}

export interface Project { id: string; name: string; path: string; createdAt: number; lastUsedAt: number }

export interface NewMission {
  projectId: string; title: string; brief: string; depth: 'quick' | 'thorough';
  baseBranch: string; missionBranch: string; isolation: 'worktree' | 'in_place'; maxParallel: number;
  settings?: unknown;
}
export interface Mission extends Omit<NewMission, 'settings'> {
  id: string; state: MissionState; outcome: MissionOutcome | null; conductorSessionId: string | null; settings: unknown;
  createdAt: number; endedAt: number | null;
}

export interface Task {
  id: string; missionId: string; planVersionId: string | null; taskKey: string; title: string; agent: string;
  prompt: string; planBody: string | null; state: TaskState; dependsOn: string[]; owns: string[]; acceptance: string;
  depth: number; onCriticalPath: boolean; sessionId: string | null; worktreePath: string | null;
  branch: string | null; handoffMd: string | null; failureReason: string | null;
  startedAt: number | null; endedAt: number | null; dispatchedAt: number | null;
  tokensIn: number; tokensOut: number; tokensCacheRead: number; tokensCacheWrite: number;
}

export type InboxKind = 'question' | 'plan_approval' | 'permission' | 'review_decision' | 'merge_decision';
export interface NewInboxEntry {
  missionId: string; taskId?: string | null; kind: InboxKind; payload: unknown; snoozedUntil?: number | null;
}
export interface InboxEntry {
  id: string; missionId: string; taskId: string | null; kind: InboxKind; requestId: string | null; payload: unknown;
  state: 'open' | 'answered' | 'expired'; answer: unknown; createdAt: number; answeredAt: number | null;
  snoozedUntil: number | null;
}

export interface SessionRow {
  id: string; missionId: string; taskId: string | null; role: string; claudeSessionId: string | null;
  pid: number | null; state: 'live' | 'ended' | 'failed'; logPath: string; startedAt: number; endedAt: number | null;
}

export interface NewEvent { missionId: string; taskId?: string | null; type: string; data: unknown; ts?: number }
export interface EventRow { id: number; missionId: string; taskId: string | null; ts: number; type: string; data: any }

type Row = Record<string, any>;
const parse = (s: string | null): any => (s == null ? null : JSON.parse(s));

const toProject = (r: Row): Project => ({
  id: r.id, name: r.name, path: r.path, createdAt: r.created_at, lastUsedAt: r.last_used_at,
});
const toMission = (r: Row): Mission => ({
  id: r.id, projectId: r.project_id, title: r.title, brief: r.brief, state: r.state, outcome: r.outcome ?? null,
  depth: r.depth, baseBranch: r.base_branch, missionBranch: r.mission_branch, isolation: r.isolation,
  maxParallel: r.max_parallel, conductorSessionId: r.conductor_session_id, settings: parse(r.settings_json),
  createdAt: r.created_at, endedAt: r.ended_at,
});
const toTask = (r: Row): Task => ({
  id: r.id, missionId: r.mission_id, planVersionId: r.plan_version_id, taskKey: r.task_key, title: r.title,
  agent: r.agent, prompt: r.prompt, planBody: r.plan_body ?? null, state: r.state,
  dependsOn: parse(r.depends_on_json), owns: parse(r.owns_json),
  acceptance: r.acceptance, depth: r.depth, onCriticalPath: r.on_critical_path === 1, sessionId: r.session_id,
  worktreePath: r.worktree_path, branch: r.branch, handoffMd: r.handoff_md, failureReason: r.failure_reason,
  startedAt: r.started_at, endedAt: r.ended_at, dispatchedAt: r.dispatched_at ?? null,
  tokensIn: r.tokens_in, tokensOut: r.tokens_out, tokensCacheRead: r.tokens_cache_read, tokensCacheWrite: r.tokens_cache_write,
});
const toInbox = (r: Row): InboxEntry => ({
  id: r.id, missionId: r.mission_id, taskId: r.task_id, kind: r.kind, requestId: r.request_id ?? null,
  payload: parse(r.payload_json), state: r.state, answer: parse(r.answer_json), createdAt: r.created_at,
  answeredAt: r.answered_at, snoozedUntil: r.snoozed_until,
});
const toSession = (r: Row): SessionRow => ({
  id: r.id, missionId: r.mission_id, taskId: r.task_id, role: r.role, claudeSessionId: r.claude_session_id,
  pid: r.pid, state: r.state, logPath: r.log_path ?? '', startedAt: r.started_at, endedAt: r.ended_at,
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
    try {
      db.prepare('INSERT INTO projects (id, name, path, path_key, created_at, last_used_at) VALUES (?,?,?,?,?,?)')
        .run(id, p.name, p.path, normalizePath(p.path), now, now);
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new DuplicateProject(p.path);
      throw err;
    }
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
  setOutcome(db: Db, id: string, outcome: MissionOutcome): void {
    const res = db.prepare('UPDATE missions SET outcome = ? WHERE id = ?').run(outcome, id);
    if (res.changes === 0) throw new Error(`Mission not found: ${id}`);
  },
  setConductorSession(db: Db, id: string, sessionId: string): void {
    const res = db.prepare('UPDATE missions SET conductor_session_id = ? WHERE id = ?').run(sessionId, id);
    if (res.changes === 0) throw new Error(`Mission not found: ${id}`);
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

const AD_HOC_KEY = /^[A-Za-z0-9-]{1,24}$/;
const getTask = (db: Db, id: string): Task => toTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row);
const isPreRun = (s: TaskState): boolean => s === 'planned' || s === 'waiting' || s === 'ready';

export const tasks = {
  insertPlan(db: Db, missionId: string, planVersionId: string, planTasks: PlanTask[], graph: PlanGraph): Task[] {
    const critical = new Set(graph.criticalPath);
    const ins = db.prepare(`INSERT INTO tasks (id, mission_id, plan_version_id, task_key, title, agent, prompt, plan_body,
      state, depends_on_json, owns_json, acceptance, depth, on_critical_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    return db.transaction(() => {
      const ids: string[] = [];
      for (const t of planTasks) {
        const id = randomUUID();
        ids.push(id);
        ins.run(id, missionId, planVersionId, t.key, t.title, t.agent, t.body, t.body, 'planned',
          JSON.stringify(t.dependsOn), JSON.stringify(t.owns), t.acceptance,
          graph.depth[t.key] ?? 0, critical.has(t.key) ? 1 : 0);
      }
      return ids.map(id => getTask(db, id));
    })();
  },
  /** Spec §6 re-plan rules. */
  applyReplan(db: Db, missionId: string, planVersionId: string, planTasks: PlanTask[], graph: PlanGraph):
    { cancelled: string[]; runningUnplanned: string[]; conflicts: string[] } {
    const critical = new Set(graph.criticalPath);
    return db.transaction(() => {
      const existing = new Map(tasks.listByMission(db, missionId).map(t => [t.taskKey, t]));
      const newKeys = new Set(planTasks.map(t => t.key));
      const upd = db.prepare(`UPDATE tasks SET plan_version_id = ?, title = ?, agent = ?, prompt = ?, plan_body = ?,
        depends_on_json = ?, owns_json = ?, acceptance = ?, depth = ?, on_critical_path = ? WHERE id = ?`);
      const ins = db.prepare(`INSERT INTO tasks (id, mission_id, plan_version_id, task_key, title, agent, prompt,
        plan_body, state, depends_on_json, owns_json, acceptance, depth, on_critical_path)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const part = db.prepare(`UPDATE tasks SET plan_version_id = ?, plan_body = ?, depends_on_json = ?, owns_json = ?,
        depth = ?, on_critical_path = ? WHERE id = ?`);
      const conflicts: string[] = [];
      for (const t of planTasks) {
        const cur = existing.get(t.key);
        const depth = graph.depth[t.key] ?? 0;
        const crit = critical.has(t.key) ? 1 : 0;
        if (!cur) {
          ins.run(randomUUID(), missionId, planVersionId, t.key, t.title, t.agent, t.body, t.body, 'planned',
            JSON.stringify(t.dependsOn), JSON.stringify(t.owns), t.acceptance, depth, crit);
        } else if (cur.planVersionId === null || cur.state === 'cancelled') {
          conflicts.push(t.key); // ad-hoc key collision, or a cancelled key re-introduced
        } else if (cur.state === 'waiting' || cur.state === 'ready') {
          part.run(planVersionId, t.body, JSON.stringify(t.dependsOn), JSON.stringify(t.owns), depth, crit, cur.id);
          appendEvent(db, { missionId, taskId: cur.id, type: 'replan', data: { planVersionId } });
        } else if (cur.state === 'planned') {
          upd.run(planVersionId, t.title, t.agent, t.body, t.body, JSON.stringify(t.dependsOn),
            JSON.stringify(t.owns), t.acceptance, depth, crit, cur.id);
          appendEvent(db, { missionId, taskId: cur.id, type: 'replan', data: { planVersionId } });
        }
      }
      const cancelled: string[] = [];
      const runningUnplanned: string[] = [];
      for (const [key, cur] of existing) {
        if (newKeys.has(key) || cur.planVersionId === null) continue;
        if (isPreRun(cur.state)) {
          tasks.transition(db, cur.id, 'cancel');
          cancelled.push(key);
        } else if (cur.state === 'running' || cur.state === 'needs_you') {
          runningUnplanned.push(key);
        }
      }
      return { cancelled, runningUnplanned, conflicts };
    })();
  },
  getByKey(db: Db, missionId: string, key: string): Task | undefined {
    const r = db.prepare('SELECT * FROM tasks WHERE mission_id = ? AND task_key = ?').get(missionId, key) as Row | undefined;
    return r && toTask(r);
  },
  dispatch(db: Db, missionId: string,
    d: { key: string; agent: string; prompt: string; dependsOn: string[]; owns: string[] }): { task: Task; created: boolean } {
    return db.transaction(() => {
      const cur = tasks.getByKey(db, missionId, d.key);
      const now = Date.now();
      const checkDeps = () => {
        if (d.dependsOn.includes(d.key)) throw new Error(`Task ${d.key} cannot depend on itself`);
        const unknown = d.dependsOn.filter(k => !tasks.getByKey(db, missionId, k));
        if (unknown.length > 0) throw new Error(`Unknown dependency key(s) for ${d.key}: ${unknown.join(', ')}`);
      };
      if (cur && (cur.state === 'planned' || cur.state === 'failed')) {
        checkDeps();
        tasks.transition(db, cur.id, cur.state === 'planned' ? 'dispatch' : 'retry');
        db.prepare(`UPDATE tasks SET prompt = ?, agent = ?, depends_on_json = ?, owns_json = ?, dispatched_at = ?
          WHERE id = ?`).run(d.prompt, d.agent, JSON.stringify(d.dependsOn), JSON.stringify(d.owns), now, cur.id);
        return { task: getTask(db, cur.id), created: false };
      }
      if (cur) return { task: cur, created: false };
      if (!AD_HOC_KEY.test(d.key)) throw new Error(`Invalid ad-hoc task key: "${d.key}"`);
      checkDeps();
      const byKey = new Map(tasks.listByMission(db, missionId).map(t => [t.taskKey, t]));
      const depth = d.dependsOn.reduce((m, k) => Math.max(m, (byKey.get(k)?.depth ?? 0) + 1), 1);
      const id = randomUUID();
      db.prepare(`INSERT INTO tasks (id, mission_id, plan_version_id, task_key, title, agent, prompt, plan_body, state,
        depends_on_json, owns_json, acceptance, depth, on_critical_path, dispatched_at)
        VALUES (?,?,NULL,?,?,?,?,NULL,'waiting',?,?,?,?,0,?)`)
        .run(id, missionId, d.key, d.key, d.agent, d.prompt, JSON.stringify(d.dependsOn), JSON.stringify(d.owns), '', depth, now);
      appendEvent(db, { missionId, taskId: id, type: 'state', data: { from: null, to: 'waiting', event: 'dispatch' } });
      return { task: getTask(db, id), created: true };
    })();
  },
  setRuntime(db: Db, id: string,
    r: Partial<{ sessionId: string; worktreePath: string; branch: string; handoffMd: string; failureReason: string }>): void {
    const cols: Record<string, string> = {
      sessionId: 'session_id', worktreePath: 'worktree_path', branch: 'branch', handoffMd: 'handoff_md',
      failureReason: 'failure_reason',
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      const v = (r as Record<string, string | undefined>)[k];
      if (v !== undefined) { sets.push(`${col} = ?`); args.push(v); }
    }
    if (sets.length === 0) return;
    const res = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    if (res.changes === 0) throw new Error(`Task not found: ${id}`);
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
      const retry = ev === 'retry' ? 1 : 0;
      const ended = to === 'done' || to === 'failed' || to === 'cancelled' ? now : null;
      db.prepare(`UPDATE tasks SET state = ?, started_at = COALESCE(?, started_at),
        ended_at = CASE WHEN ? THEN NULL ELSE COALESCE(?, ended_at) END,
        failure_reason = CASE WHEN ? THEN NULL ELSE failure_reason END,
        session_id = CASE WHEN ? THEN NULL ELSE session_id END,
        worktree_path = CASE WHEN ? THEN NULL ELSE worktree_path END WHERE id = ?`)
        .run(to, started, retry, ended, retry, retry, retry, id);
      appendEvent(db, { missionId: r.mission_id, taskId: id, type: 'state', data: { from, to, event: ev } });
      return getTask(db, id);
    })();
  },
  listByMission(db: Db, missionId: string): Task[] {
    return (db.prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY rowid').all(missionId) as Row[]).map(toTask);
  },
  addUsage(db: Db, id: string, u: TokenUsage): void {
    const res = db.prepare(`UPDATE tasks SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
      tokens_cache_read = tokens_cache_read + ?, tokens_cache_write = tokens_cache_write + ? WHERE id = ?`)
      .run(u.input, u.output, u.cacheRead, u.cacheWrite, id);
    if (res.changes === 0) throw new Error(`Task not found: ${id}`);
  },
};

export const inbox = {
  add(db: Db, e: NewInboxEntry & { requestId?: string }): InboxEntry {
    const id = randomUUID();
    db.prepare(`INSERT INTO inbox (id, mission_id, task_id, kind, request_id, payload_json, state, created_at, snoozed_until)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, e.missionId, e.taskId ?? null, e.kind, e.requestId ?? null, JSON.stringify(e.payload ?? null), 'open',
        Date.now(), e.snoozedUntil ?? null);
    return toInbox(db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as Row);
  },
  answer(db: Db, id: string, answer: unknown): InboxEntry {
    return db.transaction(() => {
      const res = db.prepare(
        "UPDATE inbox SET state = 'answered', answer_json = ?, answered_at = ? WHERE id = ? AND state = 'open'",
      ).run(JSON.stringify(answer ?? null), Date.now(), id);
      const r = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as Row | undefined;
      if (!r) throw new Error(`Inbox entry not found: ${id}`);
      if (res.changes === 0) throw r.state === 'expired' ? new Expired(id) : new AlreadyAnswered(id);
      return toInbox(r);
    })();
  },
  /** Expires every open entry of a task and returns them (in their new, expired state). */
  expireForTask(db: Db, taskId: string): InboxEntry[] {
    return db.transaction(() => {
      const rows = db.prepare("SELECT * FROM inbox WHERE task_id = ? AND state = 'open' ORDER BY created_at, rowid")
        .all(taskId) as Row[];
      db.prepare("UPDATE inbox SET state = 'expired' WHERE task_id = ? AND state = 'open'").run(taskId);
      return rows.map(r => toInbox({ ...r, state: 'expired' }));
    })();
  },
  /** Expires the open entry created for a permission request id (used on permission-cancel). */
  expireByRequestId(db: Db, requestId: string): InboxEntry | undefined {
    return db.transaction(() => {
      const r = db.prepare("SELECT * FROM inbox WHERE request_id = ? AND state = 'open' ORDER BY rowid LIMIT 1")
        .get(requestId) as Row | undefined;
      if (!r) return undefined;
      db.prepare("UPDATE inbox SET state = 'expired' WHERE id = ?").run(r.id);
      return toInbox({ ...r, state: 'expired' });
    })();
  },
  openCountForTask(db: Db, taskId: string): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE task_id = ? AND state = 'open'").get(taskId) as Row).n;
  },
  listOpen(db: Db, now: number): InboxEntry[] {
    return (db.prepare(`SELECT * FROM inbox WHERE state = 'open' AND (snoozed_until IS NULL OR snoozed_until <= ?)
      ORDER BY created_at, rowid`).all(now) as Row[]).map(toInbox);
  },
};

/** Commands with chaining, redirection or substitution never match a stored prefix. */
const UNSAFE_SHELL = /[\n\r;&|`>]|\$\(/;

export const permissionRules = {
  add(db: Db, r: { missionId: string; toolName: string; inputPrefix: string }): void {
    db.prepare('INSERT INTO permission_rules (id, mission_id, tool_name, input_prefix, created_at) VALUES (?,?,?,?,?)')
      .run(randomUUID(), r.missionId, r.toolName, r.inputPrefix.trim(), Date.now());
  },
  match(db: Db, missionId: string, toolName: string, input: unknown): boolean {
    const rules = db.prepare('SELECT input_prefix FROM permission_rules WHERE mission_id = ? AND tool_name = ?')
      .all(missionId, toolName) as Row[];
    if (toolName !== 'Bash') return rules.some(r => r.input_prefix === '');
    const cmd = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).command : undefined;
    if (typeof cmd !== 'string' || UNSAFE_SHELL.test(cmd)) return false;
    return rules.some(r => {
      const p: string = r.input_prefix;
      return cmd.startsWith(p) && (cmd.length === p.length || /\s/.test(cmd[p.length]));
    });
  },
};

export const sessions = {
  start(db: Db, s: {
    missionId: string; taskId?: string | null; role: string; claudeSessionId?: string | null;
    pid?: number | null; logPath: string;
  }): SessionRow {
    const id = randomUUID();
    db.prepare(`INSERT INTO sessions (id, mission_id, task_id, role, claude_session_id, pid, state, log_path, started_at)
      VALUES (?,?,?,?,?,?,'live',?,?)`)
      .run(id, s.missionId, s.taskId ?? null, s.role, s.claudeSessionId ?? null, s.pid ?? null, s.logPath, Date.now());
    return toSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row);
  },
  end(db: Db, id: string, state: 'ended' | 'failed'): void {
    const res = db.prepare('UPDATE sessions SET state = ?, ended_at = ? WHERE id = ?').run(state, Date.now(), id);
    if (res.changes === 0) throw new Error(`Session not found: ${id}`);
  },
  listLive(db: Db): SessionRow[] {
    return (db.prepare("SELECT * FROM sessions WHERE state = 'live' ORDER BY started_at, rowid").all() as Row[]).map(toSession);
  },
};

export const usageWindow = {
  save(db: Db, w: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; seenAt: number }): void {
    db.prepare(`INSERT INTO usage_window (id, five_hour_utilization, five_hour_resets_at, seven_day_utilization,
      seven_day_resets_at, seen_at) VALUES (1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET five_hour_utilization = excluded.five_hour_utilization,
        five_hour_resets_at = excluded.five_hour_resets_at, seven_day_utilization = excluded.seven_day_utilization,
        seven_day_resets_at = excluded.seven_day_resets_at, seen_at = excluded.seen_at`)
      .run(w.fiveHour?.utilization ?? null, w.fiveHour?.resetsAt ?? null,
        w.sevenDay?.utilization ?? null, w.sevenDay?.resetsAt ?? null, w.seenAt);
  },
  get(db: Db): { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; seenAt: number } | undefined {
    const r = db.prepare('SELECT * FROM usage_window WHERE id = 1').get() as Row | undefined;
    if (!r) return undefined;
    const win = (u: number | null, at: number | null): UsageWindow | null =>
      u == null || at == null ? null : { utilization: u, resetsAt: at };
    return {
      fiveHour: win(r.five_hour_utilization, r.five_hour_resets_at),
      sevenDay: win(r.seven_day_utilization, r.seven_day_resets_at),
      seenAt: r.seen_at,
    };
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
