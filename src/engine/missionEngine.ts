// Runs missions end to end (spec §5–§9): the mission branch, one bridge HTTP server, the conductor session, the
// bridge handlers (submit_plan, dispatch_task, wait_for_tasks, ask_user, finish_mission), task scheduling through
// the TaskRunner within the parallel limits and the rate-limit throttle, and the final Merge / Keep branch decision.
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../store/db.js';
import {
  events as eventsRepo, inbox as inboxRepo, missions, planVersions, projects, sessions, tasks, usageWindow,
  type EventRow, type InboxEntry, type Mission, type NewMission, type Task,
} from '../store/repos.js';
import { parsePlan } from '../core/plan/parsePlan.js';
import { validatePlan, type PlanError } from '../core/plan/validatePlan.js';
import { buildGraph, type PlanGraph } from '../core/plan/graph.js';
import { DEFAULT_GLOBAL_PARALLEL, pickTasksToStart, type ReadyTask } from '../core/scheduler/scheduler.js';
import { TERMINAL_MISSION_STATES, type MissionEvent } from '../core/state/missionMachine.js';
import type { PlanTask } from '../core/types.js';
import { ClaudeSession } from '../claude/session.js';
import type { StreamEvent } from '../claude/protocol.js';
import {
  branchCommits, branchExists, ensureMissionBranch, removeIntegrationWorktree, removeWorktree, worktreeDirFor,
} from '../git/worktrees.js';
import { startBridgeHttp, writeBridgeConfig, type BridgeHttp } from '../bridge/http.js';
import type { BridgeHandlers, DispatchInput, TaskSummary } from '../bridge/tools.js';
import { InboxService } from './inbox.js';
import { LiveSessionRegistry, TaskRunner, type TaskFinished } from './taskRunner.js';
import { Throttle } from './throttle.js';
import {
  checkStuck, DEFAULT_STUCK_AFTER_MS, defaultIsPidAlive, lastActivity, recoverOnStartup, type RecoveryReport,
} from './recovery.js';

const execFileP = promisify(execFile);

const DEFAULT_PROMPT_FILE = fileURLToPath(new URL('../../prompts/conductor.md', import.meta.url));
const TICK_MS = 1000;
/** shutdown() waits at most this long for an in-flight merge or stop. */
const SHUTDOWN_WAIT_MS = 15_000;
const SHUTTING_DOWN = 'Maestro is shutting down';
const PROGRESS_MS = 60_000;
/** After the mission ends, the conductor gets this long to finish its turn before it is stopped. */
const CONDUCTOR_LINGER_MS = 120_000;
export const MERGE = 'Merge';
export const KEEP = 'Keep branch';
export const STOP_TASK = 'Stop task';
export const KEEP_WAITING = 'Keep waiting';
export const CONDUCTOR_UNRECOVERABLE = 'conductor-unrecoverable';
export const CONDUCTOR_RESUME_MESSAGE =
  'Maestro restarted. Any bridge tool call you were waiting on (submit_plan, wait_for_tasks, ask_user, '
  + 'finish_mission) was interrupted: call it again with the same arguments, then continue the mission.';
const STUCK_CHECK_MS = 60_000;
/** How long recovery waits for a resumed session to confirm itself before it moves on. */
const RECOVERY_CONFIRM_MS = 30_000;
/** A plain-text conductor turn becomes a question of at most this many characters. */
const CONDUCTOR_TEXT_MAX = 2000;
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);
const ACTIVE_TASK_STATES: ReadonlySet<string> = new Set(['waiting', 'ready', 'running', 'needs_you']);
const LIVE_TASK_STATES: ReadonlySet<string> = new Set(['planned', 'waiting', 'ready', 'running', 'needs_you']);
const WAIT_TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

export interface MissionEngineOptions {
  db: Db;
  logDir: string;
  /** claude.exe path; ignored when `command` is given. */
  exe?: string;
  /** Full command override (tests: node + tsx + fake-claude). */
  command?: { exe: string; prefixArgs: string[] };
  /** Extra env for every session. */
  env?: Record<string, string>;
  /** Extra env for the conductor only, over `env` (tests: a different fake scenario). */
  conductorEnv?: Record<string, string>;
  rolesDir?: string;
  conductorPromptFile?: string;
  stopTimeoutMs?: number;
  globalMaxParallel?: number;
  /** wait_for_tasks progress interval (default 60 s). */
  progressMs?: number;
  /** Test hook: awaited right before the base-branch merge starts. */
  beforeBaseMerge?: () => Promise<void>;
  /** A running task with no event for this long gets a "seems stuck" question (default 20 min). */
  stuckAfterMs?: number;
  /** How often stuck tasks are looked for (default 60 s). */
  stuckCheckMs?: number;
  /** recover(): how long to wait for a resumed session to confirm itself (default 30 s). */
  recoveryConfirmMs?: number;
}

export type StartMissionInput = Omit<NewMission, 'missionBranch'> & {
  /** Derived from the title (`maestro/<slug>`) when omitted or empty. */
  missionBranch?: string;
  quick?: boolean;
};

export type MergeDecisionResult =
  | { outcome: 'merged' | 'kept' }
  | { outcome: 'retry'; reason: string }
  /** The mission was stopped while the merge was starting; the base branch is untouched. */
  | { outcome: 'stopped' };

type BaseMergeResult =
  | { ok: true }
  | { ok: false; reason: string; files?: string[]; halted?: 'closed' | 'stopped' };

type PlanResult = { errors: PlanError[] } | { approved: true } | { approved: false; note: string };

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => undefined); // a rejection nobody awaits must not crash the host
  return { promise, resolve, reject };
}

/** A validated plan waiting for the user. Nothing of it is in the database (besides its entry) until approvePlan. */
interface PlanWait {
  planPath: string; hash: string; md: string; planTasks: PlanTask[]; graph: PlanGraph; entryId: string; d: Deferred<PlanResult>;
}

/**
 * Plan keys that cannot be (re)planned: an ad-hoc task's key, a cancelled task's key, or an existing key that differs
 * only by case (keys name worktree folders, and Windows ignores case).
 */
function planConflicts(existing: Task[], planTasks: PlanTask[]): string[] {
  const exact = new Map(existing.map(t => [t.taskKey, t]));
  const lower = new Map(existing.map(t => [t.taskKey.toLowerCase(), t]));
  return planTasks.filter(t => {
    const cur = exact.get(t.key);
    if (cur) return cur.planVersionId === null || cur.state === 'cancelled';
    return lower.has(t.key.toLowerCase());
  }).map(t => t.key);
}

/**
 * Spec §5.2 "blocked" (derived, not a state): a waiting task with a dependency that is failed, cancelled or itself
 * blocked. It cannot start until that dependency is retried. Task id to its reason `dependency <KEY> <state>`.
 */
export function blockedTasks(list: Task[]): Map<string, string> {
  const byKey = new Map(list.map(t => [t.taskKey, t]));
  const out = new Map<string, string>();
  const visiting = new Set<string>();
  const check = (t: Task): string | null => {
    if (t.state !== 'waiting') return null;
    if (out.has(t.id)) return out.get(t.id)!;
    if (visiting.has(t.id)) return null; // a dependency cycle (ad-hoc dispatch forbids it): not blocked here
    visiting.add(t.id);
    let reason: string | null = null;
    for (const k of t.dependsOn) {
      const d = byKey.get(k);
      if (!d) continue;
      if (d.state === 'failed' || d.state === 'cancelled') { reason = `dependency ${k} ${d.state}`; break; }
      if (check(d) !== null) { reason = `dependency ${k} blocked`; break; }
    }
    visiting.delete(t.id);
    if (reason !== null) out.set(t.id, reason);
    return reason;
  };
  for (const t of list) check(t);
  return out;
}

const conflictErrors = (keys: string[]): { errors: PlanError[] } => ({
  errors: keys.map(k => ({ code: 'duplicate-key' as const, taskKeys: [k], message: `${k} conflicts with an existing task; rename it` })),
});

/** What applying the plan would do to planned tasks it drops (shown with the approval; applied on approval). */
function replanPreview(existing: Task[], planTasks: PlanTask[]): { cancelled: string[]; runningUnplanned: string[] } {
  const keys = new Set(planTasks.map(t => t.key));
  const dropped = existing.filter(t => t.planVersionId !== null && !keys.has(t.taskKey));
  return {
    cancelled: dropped.filter(t => t.state === 'planned' || t.state === 'waiting' || t.state === 'ready').map(t => t.taskKey),
    runningUnplanned: dropped.filter(t => t.state === 'running' || t.state === 'needs_you').map(t => t.taskKey),
  };
}
interface MergeWait {
  entryId: string; summary: string; d: Deferred<'merge' | 'keep'>;
  /** The base merge in flight (stop() waits for it). */
  merging: Promise<MergeDecisionResult> | null;
}

interface MissionCtx {
  id: string;
  projectRoot: string;
  missionDir: string;
  conductorCfg: string;
  runner: TaskRunner;
  conductor: ClaudeSession | null;
  /** A conductor started with --resume that has not yet confirmed its session (init with that id, or a result). */
  conductorResume: { sessionId: string; d: Deferred<boolean> } | null;
  /** Automatic conductor restarts so far (at most one per mission and engine run). */
  conductorRestarts: number;
  conductorRowId: string | null;
  subagentUses: number;
  /** The conductor's bridge calls in flight. */
  bridgeCalls: number;
  /** The open question made from a plain-text conductor turn (at most one). */
  idleEntryId: string | null;
  /** The conductor's last top-level assistant text in the current turn. */
  lastText: string;
  planWait: PlanWait | null;
  /** The last approved plan, so a re-call that raced the approval gets `{approved:true}` instead of a re-plan. */
  lastPlan: { planPath: string; hash: string; result: PlanResult } | null;
  mergeWait: MergeWait | null;
  stopPromise: Promise<void> | null;
  lingerTimer: NodeJS.Timeout | null;
  /** Set by shutdown(): the conductor's exit must not touch the database. */
  detached: boolean;
}

interface Waiter { check(): void; fail(err: Error): void }

/** Calls `onSession` for every session the runner registers, so the engine sees each task's rate-limit events. */
class EngineRegistry extends LiveSessionRegistry {
  constructor(private onSession: (s: ClaudeSession) => void) { super(); }
  override set(id: string, s: ClaudeSession): void {
    super.set(id, s);
    this.onSession(s);
  }
}

/** Lowercase, non-alphanumerics to '-', at most 30 characters. */
export function missionSlug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 30).replace(/-+$/, '');
  return s || 'mission';
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const mission8 = (id: string): string => id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(err.stderr ?? '').toString().trim() || err.message}`);
  }
}

/** Rejects empty names, a leading '-', '@{' and anything `git check-ref-format --branch` refuses. */
async function checkBranchName(root: string, name: string, kind: 'base' | 'mission'): Promise<void> {
  const bad = (why: string): Error => new Error(`Invalid ${kind} branch name "${name}": ${why}`);
  if (!name || name.startsWith('-')) throw bad('it must not be empty or start with "-"');
  if (name.includes('@{')) throw bad('it must not contain "@{"');
  try { await git(root, ['check-ref-format', '--branch', name]); }
  catch { throw bad('git check-ref-format rejects it'); }
}

export class MissionEngine extends EventEmitter implements BridgeHandlers {
  readonly inbox: InboxService;
  readonly throttle = new Throttle();
  private readonly registry: EngineRegistry;
  private readonly db: Db;
  private ctxs = new Map<string, MissionCtx>();
  private waiters = new Set<Waiter>();
  private bridge: Promise<BridgeHttp> | null = null;
  private tick: NodeJS.Timeout | null = null;
  private lastEventId = 0;
  private scheduling = false;
  private scheduleAgain = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private hooked = new WeakSet<ClaudeSession>();
  private recovering = false;
  private recoverPromise: Promise<RecoveryReport> | null = null;
  private stuckTimer: NodeJS.Timeout | null = null;
  /** Tasks with an open "seems stuck" entry. */
  private stuckOpen = new Set<string>();
  /** Task id to the time before which "Keep waiting" silences it. */
  private stuckSnoozed = new Map<string, number>();
  /** Tasks recovery left alone because a live PID (another Maestro instance?) owns them. */
  private heldTasks = new Set<string>();

  constructor(private o: MissionEngineOptions) {
    super();
    this.db = o.db;
    this.registry = new EngineRegistry(s => this.hookRateLimits(s));
    this.inbox = new InboxService(o.db, this.registry);
    this.inbox.on('changed', () => { this.emit('inbox'); this.kick(); });
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get() as { n: number };
    this.lastEventId = row.n;
  }

  private warn(msg: string): void { console.error(`[maestro engine] ${msg}`); }

  /** True once shutdown() has begun. */
  get isClosed(): boolean { return this.closed; }

  /** Every bridge handler and user-facing mutator refuses once shutdown() has begun. */
  private assertOpen(): void {
    if (this.closed) throw new Error(SHUTTING_DOWN);
  }

  // ---- lookups ---------------------------------------------------------------

  private ctx(missionId: string): MissionCtx {
    const c = this.ctxs.get(missionId);
    if (!c) throw new Error(`Unknown mission: ${missionId}`);
    return c;
  }

  private mission(missionId: string): Mission {
    const m = missions.get(this.db, missionId);
    if (!m) throw new Error(`Unknown mission: ${missionId}`);
    return m;
  }

  private ownTask(missionId: string, taskId: string): Task {
    const t = tasks.get(this.db, taskId);
    if (!t) throw new Error(`Unknown task: ${taskId}`);
    if (t.missionId !== missionId) throw new Error(`Task ${taskId} does not belong to mission ${missionId}`);
    return t;
  }

  private transition(missionId: string, ev: MissionEvent): Mission {
    const m = missions.transition(this.db, missionId, ev);
    this.emit('mission', m);
    this.flushEvents();
    return m;
  }

  private appendEvent(missionId: string, type: string, data: unknown, taskId: string | null = null): void {
    eventsRepo.append(this.db, { missionId, taskId, type, data });
    this.flushEvents();
  }

  /** Emits every event row written since the last flush (by the engine, the runner or the repos). */
  private flushEvents(): void {
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(this.lastEventId) as Record<string, any>[];
    for (const r of rows) {
      this.lastEventId = r.id;
      const ev: EventRow = {
        id: r.id, missionId: r.mission_id, taskId: r.task_id, ts: r.ts, type: r.type,
        data: r.data_json == null ? null : JSON.parse(r.data_json),
      };
      try { this.emit('event', ev); } catch (e) { this.warn(`event listener: ${(e as Error).message}`); }
    }
  }

  private addEntry(missionId: string, kind: InboxEntry['kind'], payload: unknown): InboxEntry {
    const e = inboxRepo.add(this.db, { missionId, taskId: null, kind, payload });
    this.emit('inbox');
    return e;
  }

  // ---- start -----------------------------------------------------------------

  private ensureBridge(): Promise<BridgeHttp> {
    if (!this.bridge) {
      this.bridge = startBridgeHttp(this);
      this.bridge.catch(() => { this.bridge = null; });
    }
    return this.bridge;
  }

  private startTick(): void {
    if (this.closed) return;
    if (!this.tick) {
      this.tick = setInterval(() => this.kick(), TICK_MS);
      this.tick.unref();
    }
    if (!this.stuckTimer) {
      this.stuckTimer = setInterval(() => {
        try { this.checkStuckTasks(); } catch (e) { this.warn(`stuck check: ${(e as Error).message}`); }
      }, this.o.stuckCheckMs ?? STUCK_CHECK_MS);
      this.stuckTimer.unref();
    }
  }

  /** The engine context of a mission: its task runner and conductor bridge config. */
  private createCtx(m: Mission, root: string, bridge: BridgeHttp): MissionCtx {
    const missionDir = join(this.o.logDir, 'missions', m.id);
    const conductorCfg = writeBridgeConfig(missionDir, {
      port: bridge.port, token: bridge.token, missionId: m.id, tools: 'conductor',
    });
    const runner = new TaskRunner({
      db: this.db, inbox: this.inbox, registry: this.registry, projectRoot: root, missionBranch: m.missionBranch,
      bridgeAskConfig: taskId => writeBridgeConfig(join(this.o.logDir, 'tasks', taskId), {
        port: bridge.port, token: bridge.token, missionId: m.id, taskId, tools: 'task',
      }),
      logDir: join(missionDir, 'tasks'), exe: this.o.exe, command: this.o.command, env: this.o.env,
      rolesDir: this.o.rolesDir, stopTimeoutMs: this.o.stopTimeoutMs,
    });
    const c: MissionCtx = {
      id: m.id, projectRoot: root, missionDir, conductorCfg, runner, conductor: null, conductorResume: null,
      conductorRestarts: 0, conductorRowId: null, subagentUses: 0, bridgeCalls: 0, idleEntryId: null, lastText: "",
      planWait: null, lastPlan: null, mergeWait: null, stopPromise: null, lingerTimer: null, detached: false,
    };
    this.ctxs.set(m.id, c);
    runner.on('state', () => { this.flushEvents(); this.kick(); });
    runner.on('finished', (_f: TaskFinished) => { this.flushEvents(); this.kick(); });
    return c;
  }

  async startMission(input: StartMissionInput): Promise<Mission> {
    this.assertOpen();
    const { quick, missionBranch: givenBranch, ...rest } = input;
    const project = projects.list(this.db).find(p => p.id === input.projectId);
    if (!project) throw new Error(`Unknown project: ${input.projectId}`);
    const root = project.path;

    let branch = givenBranch || `maestro/${missionSlug(input.title)}`;
    await checkBranchName(root, input.baseBranch, 'base');
    await checkBranchName(root, branch, 'mission');
    if (branch === input.baseBranch) {
      throw new Error(`The mission branch is the same as the base branch (${branch}); choose another mission branch`);
    }
    if (!(await branchExists(root, input.baseBranch))) {
      throw new Error(`Base branch ${input.baseBranch} does not exist in ${root}`);
    }
    let m = missions.create(this.db, { ...rest, missionBranch: branch });
    try {
      if (!givenBranch && await branchExists(root, branch)) {
        branch = `${branch}-${mission8(m.id)}`;
        missions.setMissionBranch(this.db, m.id, branch);
      }
      await ensureMissionBranch(root, input.baseBranch, branch);
      const bridge = await this.ensureBridge();
      const c = this.createCtx(missions.get(this.db, m.id)!, root, bridge);

      m = this.transition(m.id, quick || input.depth === 'quick' ? 'start_quick' : 'start');
      this.startConductor(c, m);
      this.startTick();
      return missions.get(this.db, m.id)!;
    } catch (e) {
      const cur = missions.get(this.db, m.id);
      if (cur && !TERMINAL_MISSION_STATES.has(cur.state)) {
        try { this.transition(m.id, 'fail'); } catch { /* ignore */ }
      }
      const c = this.ctxs.get(m.id);
      if (c) {
        if (c.conductor) await c.conductor.stop(this.o.stopTimeoutMs ?? 5000).catch(() => undefined);
        c.runner.dispose();
        this.ctxs.delete(m.id);
      }
      throw e;
    }
  }

  /**
   * Spec §7.1. The brief and settings are the first user message. With `resumeSessionId` (spec §12): the session is
   * resumed with --resume and told that its pending bridge calls were interrupted; it must confirm the session (an
   * init with the same id, or a result) before it exits, or the mission fails.
   */
  private startConductor(c: MissionCtx, m: Mission, resumeSessionId?: string): void {
    const missionDir = c.missionDir;
    mkdirSync(missionDir, { recursive: true });
    const args = [
      '--model', 'opus',
      '--mcp-config', c.conductorCfg,
      '--append-system-prompt-file', this.o.conductorPromptFile ?? DEFAULT_PROMPT_FILE,
      '--permission-mode', 'default',
      // As in the R1 runs: the bridge's own tools never prompt (every other tool does).
      '--allowedTools', 'mcp__maestro__*',
    ];
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
      c.conductorResume = { sessionId: resumeSessionId, d: deferred<boolean>() };
      c.conductorRestarts++;
    }
    const logPath = join(missionDir, 'conductor.log');
    const command = this.o.command ?? (this.o.exe ? { exe: this.o.exe, prefixArgs: [] } : undefined);
    const session = ClaudeSession.start({
      args, cwd: c.projectRoot, logPath, env: { ...this.o.env, ...this.o.conductorEnv }, command,
    });
    c.conductor = session;
    session.on('error', (e: Error) => this.warn(`conductor ${m.id}: ${e.message}`));
    session.on('event', (ev: StreamEvent) => {
      try { this.onConductorEvent(c, ev); } catch (e) { this.warn(`conductor event ${ev.kind}: ${(e as Error).message}`); }
    });
    session.on('exit', (info: { code: number | null }) => this.onConductorExit(c, info.code));
    const row = sessions.start(this.db, {
      missionId: m.id, taskId: null, role: 'conductor', claudeSessionId: resumeSessionId ?? null, pid: session.pid, logPath,
    });
    c.conductorRowId = row.id;
    this.registry.set(row.id, session);
    session.send(resumeSessionId ? CONDUCTOR_RESUME_MESSAGE : this.missionBrief(m));
  }

  private confirmConductor(c: MissionCtx, ok: boolean): void {
    const r = c.conductorResume;
    if (!r) return;
    c.conductorResume = null;
    r.d.resolve(ok);
  }

  private missionBrief(m: Mission): string {
    const settings = [
      `- Planning depth: ${m.depth}`,
      `- Base branch: ${m.baseBranch}`,
      `- Mission branch: ${m.missionBranch}`,
      `- Isolation: ${m.isolation}`,
      `- Parallel tasks: up to ${m.maxParallel}`,
    ];
    if (m.settings !== null && m.settings !== undefined) settings.push(`- Other settings: ${JSON.stringify(m.settings)}`);
    return `# Mission: ${m.title}\n\n${m.brief.trim()}\n\n## Settings\n\n${settings.join('\n')}\n`;
  }

  private onConductorEvent(c: MissionCtx, ev: StreamEvent): void {
    if (this.closed) return; // shutting down: the conductor writes nothing more
    switch (ev.kind) {
      case 'init':
        if (c.conductorResume && ev.sessionId === c.conductorResume.sessionId) this.confirmConductor(c, true);
        if (ev.sessionId) {
          missions.setConductorSession(this.db, c.id, ev.sessionId);
          if (c.conductorRowId) sessions.setClaudeSessionId(this.db, c.conductorRowId, ev.sessionId);
        }
        return;
      case 'assistant':
        for (const tu of ev.toolUses) {
          if (!SUBAGENT_TOOLS.has(tu.name)) continue;
          c.subagentUses++;
          this.appendEvent(c.id, 'conductor-subagent-warning', { tool: tu.name, count: c.subagentUses, toolUseId: tu.id });
        }
        if (ev.parentToolUseId === null && ev.text.trim()) {
          c.lastText = ev.text.trim();
          try { this.emit('conductor-text', { missionId: c.id, text: c.lastText }); }
          catch (e) { this.warn(`conductor-text listener: ${(e as Error).message}`); }
        }
        return;
      case 'permission-request':
        if (c.conductorRowId && !c.stopPromise) this.inbox.onPermissionRequest(c.id, null, c.conductorRowId, ev);
        return;
      case 'permission-cancel':
        this.inbox.onPermissionCancel(ev.requestId);
        return;
      case 'result': {
        this.confirmConductor(c, true);
        const text = (ev.text?.trim() || c.lastText).trim();
        c.lastText = '';
        if (c.lingerTimer) { this.closeConductor(c); return; } // the mission ended; this was the conductor's last turn
        if (ev.ok) this.onConductorIdle(c, text);
        return;
      }
      default:
        return; // rate-limit events are handled for every session via the registry
    }
  }

  /**
   * The conductor ended a turn with plain text while no bridge call of its own is pending: it is waiting for the
   * user, who cannot see its replies (spec §7.1). Its last text becomes one free-text question (never more than one
   * open); the answer goes back to the conductor as a user message.
   */
  private onConductorIdle(c: MissionCtx, text: string): void {
    if (c.bridgeCalls > 0 || c.stopPromise || c.idleEntryId) return;
    const m = missions.get(this.db, c.id);
    if (!m || TERMINAL_MISSION_STATES.has(m.state)) return;
    const shown = text.length > CONDUCTOR_TEXT_MAX ? `${text.slice(0, CONDUCTOR_TEXT_MAX - 1)}…` : text;
    const question = shown || 'The conductor ended its turn without a message. Tell it how to continue.';
    const asked = this.inbox.ask(c.id, null, question);
    const entry = inboxRepo.listOpenForMission(this.db, c.id).filter(e => e.kind === 'question' && e.taskId === null).at(-1);
    c.idleEntryId = entry?.id ?? null;
    asked.then(answer => {
      c.idleEntryId = null;
      if (this.closed || c.stopPromise) return;
      const s = c.conductor;
      if (!s || s.status === 'exited') { this.warn(`conductor ${c.id} is gone; the answer was not delivered`); return; }
      try { s.send(answer); } catch (e) { this.warn(`send to conductor: ${(e as Error).message}`); }
    }, () => { c.idleEntryId = null; }); // expired (stop, restart) or shutdown
  }

  /** Counts the conductor's bridge calls in flight, so a turn that ends while one is pending is not "idle". */
  private conductorCall<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
    const c = this.ctxs.get(missionId);
    if (!c) return fn();
    c.bridgeCalls++;
    let p: Promise<T>;
    try { p = fn(); } catch (e) { c.bridgeCalls--; throw e; }
    return p.finally(() => { c.bridgeCalls--; });
  }

  private onConductorExit(c: MissionCtx, code: number | null): void {
    // First, so a recovery waiting on this resume never hangs (even during shutdown).
    const unconfirmed = c.conductorResume !== null;
    this.confirmConductor(c, false);
    if (c.detached || this.closed) return; // shutdown() ends the row itself and changes nothing else
    if (c.conductorRowId) {
      this.registry.delete(c.conductorRowId);
      try { sessions.end(this.db, c.conductorRowId, code === 0 ? 'ended' : 'failed'); } catch { /* already ended */ }
    }
    if (c.lingerTimer) { clearTimeout(c.lingerTimer); c.lingerTimer = null; }
    const m = missions.get(this.db, c.id);
    if (!m || TERMINAL_MISSION_STATES.has(m.state) || c.stopPromise) return;
    this.appendEvent(c.id, 'conductor-exited', { code, resumed: c.conductorRestarts > 0 });
    // Spec §12: restart with --resume once; a resume that never confirmed its session, or a second exit, fails it.
    if (!unconfirmed && c.conductorRestarts === 0 && m.conductorSessionId) {
      this.startConductor(c, m, m.conductorSessionId);
      return;
    }
    void this.failMission(c, CONDUCTOR_UNRECOVERABLE);
  }

  private closeConductor(c: MissionCtx): void {
    if (c.lingerTimer) { clearTimeout(c.lingerTimer); c.lingerTimer = null; }
    const s = c.conductor;
    if (!s || s.status === 'exited') return;
    try { s.close(); } catch { void s.stop(this.o.stopTimeoutMs ?? 5000).catch(() => undefined); }
  }

  /** The mission is done: let the conductor finish the turn that received finish_mission's result, then end it. */
  private releaseConductor(c: MissionCtx): void {
    const s = c.conductor;
    if (!s || s.status === 'exited') return;
    if (s.status !== 'busy') { this.closeConductor(c); return; }
    c.lingerTimer = setTimeout(() => {
      c.lingerTimer = null;
      void s.stop(this.o.stopTimeoutMs ?? 5000).catch(() => undefined);
    }, CONDUCTOR_LINGER_MS);
    c.lingerTimer.unref();
  }

  private hookRateLimits(s: ClaudeSession): void {
    if (this.hooked.has(s)) return;
    this.hooked.add(s);
    s.on('event', (ev: StreamEvent) => {
      if (ev.kind !== 'rate-limit' || this.closed) return;
      const now = Date.now();
      this.throttle.onRateLimit(ev, now);
      if (ev.fiveHour || ev.sevenDay) {
        try { usageWindow.save(this.db, { fiveHour: ev.fiveHour, sevenDay: ev.sevenDay, seenAt: now }); }
        catch (e) { this.warn(`usage window: ${(e as Error).message}`); }
      }
    });
  }

  // ---- submit_plan -------------------------------------------------------------

  private resolvePlanPath(c: MissionCtx, planPath: string): string {
    return isAbsolute(planPath) ? resolve(planPath) : resolve(c.projectRoot, planPath);
  }

  submitPlan(missionId: string, planPath: string): Promise<PlanResult> {
    return this.conductorCall(missionId, () => this.doSubmitPlan(missionId, planPath));
  }

  private async doSubmitPlan(missionId: string, planPath: string): Promise<PlanResult> {
    this.assertOpen();
    const c = this.ctx(missionId);
    if (c.stopPromise) throw new Error('The mission is stopping');
    const abs = this.resolvePlanPath(c, planPath);
    let md: string;
    try { md = readFileSync(abs, 'utf8'); } catch (e) { throw new Error(`Cannot read the plan file ${abs}: ${(e as Error).message}`); }
    const hash = sha256(md);
    const same = (x: { planPath: string; hash: string } | null): boolean =>
      x !== null && x.planPath.toLowerCase() === abs.toLowerCase() && x.hash === hash;
    // Idempotent: the same plan (path and content) while its approval is pending re-attaches to the same wait.
    if (same(c.planWait)) return c.planWait!.d.promise;
    // ...and a re-call that raced the approval gets the approval.
    if (same(c.lastPlan)) return c.lastPlan!.result;

    const m = this.mission(missionId);
    if (!['understanding', 'planning', 'awaiting_approval', 'running'].includes(m.state)) {
      throw new Error(`Cannot submit a plan while the mission is ${m.state}`);
    }
    const planTasks = parsePlan(md);
    const errors = validatePlan(planTasks);
    if (errors.length > 0) return { errors };

    // Conflicts are found now (pre-check); nothing is written until the user approves (approvePlan applies it).
    const existing = tasks.listByMission(this.db, missionId);
    const conflicts = planConflicts(existing, planTasks);
    if (conflicts.length > 0) return conflictErrors(conflicts);
    const graph = buildGraph(planTasks);
    const preview = replanPreview(existing, planTasks);
    const version = this.nextPlanVersion(missionId);

    // A different plan (or the same file with new content) while one is pending supersedes it.
    if (c.planWait) {
      const old = c.planWait;
      c.planWait = null;
      inboxRepo.expire(this.db, old.entryId);
      old.d.resolve({ approved: false, note: 'Superseded by a newer submit_plan call.' });
    }
    c.lastPlan = null;

    if (m.state === 'understanding') this.transition(missionId, 'understood');
    if (m.state === 'running') this.transition(missionId, 'replan');
    if (m.state !== 'awaiting_approval') this.transition(missionId, 'plan_submitted');
    this.flushEvents();

    const entry = this.addEntry(missionId, 'plan_approval', {
      version, planPath: abs, planMd: md, taskKeys: planTasks.map(t => t.key),
      tasks: planTasks.map(t => ({ key: t.key, title: t.title, agent: t.agent, dependsOn: t.dependsOn, owns: t.owns })),
      waves: graph.waves, criticalPath: graph.criticalPath,
      cancelled: preview.cancelled, runningUnplanned: preview.runningUnplanned,
    });
    const d = deferred<PlanResult>();
    c.planWait = { planPath: abs, hash, md, planTasks, graph, entryId: entry.id, d };
    this.kick();
    return d.promise;
  }

  private nextPlanVersion(missionId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM plan_versions WHERE mission_id = ?')
      .get(missionId) as { v: number }).v + 1;
  }

  /**
   * Spec §6: the plan is applied only now. In one transaction: the mission moves to running, the plan version is
   * created and approved, its tasks are inserted (first plan) or applied as a re-plan, and the entry is answered. A
   * conflict that appeared since submit_plan (e.g. a task was cancelled meanwhile) rolls everything back and leaves
   * the entry open: the user can send a re-plan note instead.
   */
  approvePlan(missionId: string): void {
    this.assertOpen();
    const c = this.ctx(missionId);
    const w = c.planWait;
    if (!w) throw new Error(`Mission ${missionId} has no plan waiting for approval`);
    let m!: Mission;
    this.db.transaction(() => {
      m = missions.transition(this.db, missionId, 'approve'); // first: an illegal transition changes nothing
      const existing = tasks.listByMission(this.db, missionId);
      const conflicts = planConflicts(existing, w.planTasks);
      if (conflicts.length > 0) {
        throw new Error(`The plan now conflicts with existing tasks (${conflicts.join(', ')}); send a re-plan note instead`);
      }
      const pv = planVersions.create(this.db, { missionId, version: this.nextPlanVersion(missionId), planPath: w.planPath, planMd: w.md });
      if (existing.length === 0) tasks.insertPlan(this.db, missionId, pv.id, w.planTasks, w.graph);
      else {
        const r = tasks.applyReplan(this.db, missionId, pv.id, w.planTasks, w.graph);
        if (r.conflicts.length > 0) {
          throw new Error(`The plan now conflicts with existing tasks (${r.conflicts.join(', ')}); send a re-plan note instead`);
        }
      }
      planVersions.approve(this.db, pv.id);
      inboxRepo.answer(this.db, w.entryId, { approved: true });
    })();
    this.emit('mission', m);
    this.flushEvents();
    c.planWait = null;
    c.lastPlan = { planPath: w.planPath, hash: w.hash, result: { approved: true } };
    this.emit('inbox');
    w.d.resolve({ approved: true });
    this.kick();
  }

  replan(missionId: string, note: string): void {
    this.assertOpen();
    const c = this.ctx(missionId);
    const w = c.planWait;
    if (!w) throw new Error(`Mission ${missionId} has no plan waiting for approval`);
    this.transition(missionId, 'replan');
    inboxRepo.answer(this.db, w.entryId, { approved: false, note });
    c.planWait = null;
    c.lastPlan = null; // an unchanged plan resubmitted after a note goes back to the user
    this.emit('inbox');
    w.d.resolve({ approved: false, note });
  }

  // ---- dispatch_task -----------------------------------------------------------

  dispatchTask(missionId: string, d: DispatchInput): Promise<{ task_ref: string }> {
    return this.conductorCall(missionId, () => this.doDispatchTask(missionId, d));
  }

  private async doDispatchTask(missionId: string, d: DispatchInput): Promise<{ task_ref: string }> {
    this.assertOpen();
    const c = this.ctx(missionId);
    const m = this.mission(missionId);
    if (m.state !== 'running') {
      throw new Error(m.state === 'planning' || m.state === 'awaiting_approval' || m.state === 'understanding'
        ? 'The plan is not approved yet: call submit_plan and wait for approval before dispatching tasks'
        : `Cannot dispatch tasks while the mission is ${m.state}`);
    }
    if (c.stopPromise) throw new Error('The mission is stopping');
    const cur = tasks.getByKey(this.db, missionId, d.task_id);
    if (cur && (cur.state === 'done' || cur.state === 'cancelled')) {
      throw new Error(`Task ${d.task_id} is ${cur.state}; use a new task id for more work`);
    }
    if (cur && cur.state !== 'planned' && cur.state !== 'failed') return { task_ref: cur.id }; // re-dispatch (failed = retry)
    this.checkOwnership(missionId, d);
    const { task } = tasks.dispatch(this.db, missionId, {
      key: d.task_id, agent: d.agent, prompt: d.prompt, dependsOn: d.depends_on, owns: d.owns,
    });
    this.flushEvents();
    this.kick();
    return { task_ref: task.id };
  }

  /** Spec §6 ad-hoc rule: the task's `owns` must not overlap an active task that is not its ancestor/descendant. */
  private checkOwnership(missionId: string, d: DispatchInput): void {
    if (d.owns.length === 0) return;
    const all = tasks.listByMission(this.db, missionId).filter(t => t.state !== 'cancelled' && t.taskKey !== d.task_id);
    const active = new Set(all.filter(t => ACTIVE_TASK_STATES.has(t.state)).map(t => t.taskKey));
    if (active.size === 0) return;
    const asPlan = (t: { key: string; dependsOn: string[]; owns: string[] }): PlanTask => ({
      key: t.key, title: t.key, body: '', dependsOn: t.dependsOn, agent: 'implementer', owns: t.owns, acceptance: 'x', estimate: 1,
    });
    const graph = [
      ...all.map(t => asPlan({ key: t.taskKey, dependsOn: t.dependsOn, owns: t.owns })),
      asPlan({ key: d.task_id, dependsOn: d.depends_on, owns: d.owns }),
    ];
    // Reuses validatePlan's ownership check (case-insensitive, ignores ./, skips ancestors and descendants).
    const hits = validatePlan(graph).filter(e => e.code === 'ownership-overlap'
      && e.taskKeys.includes(d.task_id) && e.taskKeys.some(k => k !== d.task_id && active.has(k)));
    if (hits.length > 0) {
      throw new Error(`Ownership overlap: ${hits.map(h => h.message).join(' ')} Add a dependency or narrow owns.`);
    }
  }

  // ---- scheduling --------------------------------------------------------------

  /** Runs a scheduling pass now (or right after the current one) and re-checks the waiters. */
  private kick(): void {
    if (this.closed || this.recovering) return;
    if (this.scheduling) { this.scheduleAgain = true; return; }
    this.scheduling = true;
    try {
      do {
        this.scheduleAgain = false;
        this.schedulePass();
      } while (this.scheduleAgain);
    } catch (e) {
      this.warn(`schedule: ${(e as Error).message}`);
    } finally {
      this.scheduling = false;
    }
    for (const w of [...this.waiters]) w.check();
    this.flushEvents();
  }

  private schedulePass(): void {
    const ready: ReadyTask[] = [];
    const runningByMission: Record<string, number> = {};
    const maxParallelByMission: Record<string, number> = {};
    for (const c of this.ctxs.values()) {
      const m = missions.get(this.db, c.id);
      if (!m) continue;
      const list = tasks.listByMission(this.db, c.id);
      runningByMission[c.id] = list.filter(t => t.state === 'running' || t.state === 'needs_you').length;
      // Only running missions start tasks (not while re-planning, finishing, stopping or ended).
      if (m.state !== 'running' || c.stopPromise) continue;
      maxParallelByMission[c.id] = m.maxParallel;
      const done = new Set(list.filter(t => t.state === 'done').map(t => t.taskKey));
      for (const t of list) {
        if (t.state === 'waiting' && t.dependsOn.every(k => done.has(k))) {
          tasks.transition(this.db, t.id, 'deps_met');
          t.state = 'ready';
        }
        if (t.state === 'ready') {
          ready.push({ id: t.id, missionId: c.id, onCriticalPath: t.onCriticalPath, readyAt: t.dispatchedAt ?? 0 });
        }
      }
    }
    const now = Date.now();
    const picks = pickTasksToStart({
      ready, runningByMission, maxParallelByMission,
      globalMax: this.o.globalMaxParallel ?? DEFAULT_GLOBAL_PARALLEL,
      throttledUntil: this.throttle.throttledUntil(now), now,
    });
    for (const id of picks) {
      const t = tasks.get(this.db, id)!;
      const c = this.ctxs.get(t.missionId)!;
      const upstream = t.dependsOn.map(k => tasks.getByKey(this.db, t.missionId, k))
        .filter((u): u is Task => u !== undefined)
        .map(u => ({ key: u.taskKey, handoff: u.handoffMd ?? '' }));
      // start() moves the task to running synchronously, before its first await.
      c.runner.start(id, upstream).catch(e => this.warn(`start ${t.taskKey}: ${(e as Error).message}`));
    }
  }

  // ---- wait_for_tasks ----------------------------------------------------------

  waitForTasks(missionId: string, refs: string[], mode: 'all' | 'any', onProgress: () => void): Promise<TaskSummary[]> {
    return this.conductorCall(missionId, () => this.doWaitForTasks(missionId, refs, mode, onProgress));
  }

  private async doWaitForTasks(missionId: string, refs: string[], mode: 'all' | 'any', onProgress: () => void): Promise<TaskSummary[]> {
    const c = this.ctx(missionId);
    for (const r of refs) this.ownTask(missionId, r);
    const isDone = (): boolean => {
      if (refs.length === 0) return true;
      const blocked = blockedTasks(tasks.listByMission(this.db, missionId));
      const resolved = refs.map(r => WAIT_TERMINAL.has(tasks.get(this.db, r)?.state ?? 'cancelled') || blocked.has(r));
      return mode === 'any' ? resolved.some(Boolean) : resolved.every(Boolean);
    };
    if (!isDone()) {
      this.assertOpen();
      await new Promise<void>((res, rej) => {
        const progress = setInterval(() => { try { onProgress(); } catch { /* ignore */ } }, this.o.progressMs ?? PROGRESS_MS);
        progress.unref();
        const end = (): void => { clearInterval(progress); this.waiters.delete(w); };
        const w: Waiter = {
          check: () => { if (isDone()) { end(); res(); } },
          fail: (err: Error) => { end(); rej(err); },
        };
        this.waiters.add(w);
      });
    }
    return Promise.all(refs.map(r => this.summary(c, r)));
  }

  private async summary(c: MissionCtx, ref: string): Promise<TaskSummary> {
    const t = tasks.get(this.db, ref)!;
    const m = this.mission(c.id);
    let commits: string[] = [];
    if (t.branch) {
      // After the task merged, missionBranch..branch is empty: list the task's own commits from the merge's
      // first parent instead.
      const merged = eventsRepo.list(this.db, c.id, { taskId: t.id, order: 'desc' }).find(e => e.type === 'merged');
      const base = t.state === 'done' && merged?.data?.commit ? `${merged.data.commit}^1` : m.missionBranch;
      try { commits = await branchCommits(c.projectRoot, base, t.branch); } catch { commits = []; }
    }
    const blocked = blockedTasks(tasks.listByMission(this.db, c.id)).get(t.id);
    const status: TaskSummary['status'] = t.state === 'done' || t.state === 'failed' || t.state === 'cancelled' ? t.state
      : blocked ? 'blocked' : 'running';
    return {
      task_ref: t.id, key: t.taskKey, status, handoff: t.handoffMd, branch: t.branch, commits,
      failure_reason: blocked ?? t.failureReason,
    };
  }

  // ---- ask_user ----------------------------------------------------------------

  askUser(missionId: string, taskId: string | null, q: { question: string; options?: string[]; context?: string }): Promise<string> {
    if (taskId !== null) return this.doAskUser(missionId, taskId, q); // a task session's question
    return this.conductorCall(missionId, () => this.doAskUser(missionId, taskId, q));
  }

  private async doAskUser(missionId: string, taskId: string | null, q: { question: string; options?: string[]; context?: string }): Promise<string> {
    this.assertOpen();
    const c = this.ctx(missionId);
    if (taskId !== null) this.ownTask(missionId, taskId);
    if (c.stopPromise) throw new Error('The mission is stopping');
    const text = q.context?.trim() ? `${q.question}\n\nContext: ${q.context.trim()}` : q.question;
    const options = q.options && q.options.length > 0 ? q.options : undefined;
    return this.inbox.ask(missionId, taskId, text, options);
  }

  // ---- finish_mission ----------------------------------------------------------

  finishMission(missionId: string, summary: string): Promise<'merge' | 'keep'> {
    return this.conductorCall(missionId, () => this.doFinishMission(missionId, summary));
  }

  private async doFinishMission(missionId: string, summary: string): Promise<'merge' | 'keep'> {
    this.assertOpen();
    const c = this.ctx(missionId);
    if (c.stopPromise) throw new Error('The mission is stopping');
    if (c.mergeWait) return c.mergeWait.d.promise; // idempotent re-call
    const m = this.mission(missionId);
    if (m.state !== 'running') throw new Error(`Cannot finish the mission while it is ${m.state}`);
    const list = tasks.listByMission(this.db, missionId);
    const blocked = blockedTasks(list); // blocked tasks never run on their own: they are cancelled when the mission ends
    const active = list.filter(t => !blocked.has(t.id)
      && (ACTIVE_TASK_STATES.has(t.state) || (t.state === 'planned' && t.dispatchedAt !== null)));
    if (active.length > 0) {
      throw new Error(`${active.length} tasks are still active: ${active.map(t => t.taskKey).join(', ')}; wait for them or stop them first`);
    }
    this.transition(missionId, 'finish_requested');
    const d = deferred<'merge' | 'keep'>();
    const w: MergeWait = { entryId: '', summary, merging: null, d };
    c.mergeWait = w;
    w.entryId = this.mergeEntry(m, summary).id;
    return d.promise;
  }

  private mergeEntry(m: Mission, summary: string, message?: string): InboxEntry {
    return this.addEntry(m.id, 'merge_decision', {
      summary, options: [MERGE, KEEP], baseBranch: m.baseBranch, missionBranch: m.missionBranch,
      ...(message ? { message } : {}),
    });
  }

  /** The user's answer to a merge_decision entry. A failed merge creates a new entry and keeps the mission finishing. */
  async answerMergeDecision(entryId: string, answer: string): Promise<MergeDecisionResult> {
    this.assertOpen();
    const entry = inboxRepo.get(this.db, entryId);
    if (!entry || entry.kind !== 'merge_decision') throw new Error(`Not a merge decision: ${entryId}`);
    const c = this.ctx(entry.missionId);
    const w = c.mergeWait;
    if (!w || w.entryId !== entryId) {
      if (entry.state !== 'open') inboxRepo.answer(this.db, entryId, answer); // throws AlreadyAnswered / Expired
      throw new Error(`Merge decision ${entryId} is not the mission's current one`);
    }
    if (answer !== MERGE && answer !== KEEP) throw new Error(`Answer must be one of the options: ${MERGE}, ${KEEP}`);
    if (c.stopPromise) throw new Error('The mission is stopping');
    if (w.merging) throw new Error('A merge is already in progress');
    const m = this.mission(c.id);

    if (answer === KEEP) {
      inboxRepo.answer(this.db, entryId, answer);
      this.emit('inbox');
      this.transition(c.id, 'kept');
      missions.setOutcome(this.db, c.id, 'kept');
      this.emit('mission', this.mission(c.id));
      this.endMission(c);
      w.d.resolve('keep');
      // The integration worktree holds the mission branch: remove it, so the user can check the kept branch out.
      try { await removeIntegrationWorktree(c.projectRoot, c.id); }
      catch (e) { this.warn(`remove integration worktree: ${(e as Error).message}`); }
      return { outcome: 'kept' };
    }

    // The entry is answered only once the merge has an outcome, so a merge halted by shutdown leaves it open.
    // stop() and shutdown() wait for this promise before they change or tear down anything.
    const merging = this.runMerge(c, w, m, entryId);
    w.merging = merging;
    try { return await merging; } finally { w.merging = null; }
  }

  private async runMerge(c: MissionCtx, w: MergeWait, m: Mission, entryId: string): Promise<MergeDecisionResult> {
    let res: BaseMergeResult;
    try { res = await this.mergeIntoBase(c, m); }
    catch (e) { res = { ok: false, reason: (e as Error).message }; }

    if (res.ok) {
      // The base branch now has the work: record it even if a stop or shutdown arrived meanwhile (both wait for us).
      this.answerQuietly(entryId, MERGE);
      if (this.mission(c.id).state === 'finishing') {
        this.transition(c.id, 'merged');
        missions.setOutcome(this.db, c.id, 'merged');
        this.emit('mission', this.mission(c.id));
      }
      try { await removeIntegrationWorktree(c.projectRoot, c.id); }
      catch (e) { this.warn(`remove integration worktree: ${(e as Error).message}`); }
      this.endMission(c);
      w.d.resolve('merge');
      return { outcome: 'merged' };
    }
    // Halted before the merge: shutdown writes nothing (the entry stays open); a stop expires the entry itself.
    if (res.halted === 'closed' || this.closed) throw new Error('Maestro is shutting down');
    if (res.halted === 'stopped' || c.stopPromise || this.mission(c.id).state !== 'finishing') return { outcome: 'stopped' };
    this.answerQuietly(entryId, MERGE);
    if (res.files) {
      this.appendEvent(c.id, 'merge-conflict', { files: res.files });
      // Informational: the answer itself is not needed (the user acts on the new merge decision).
      this.inbox.ask(c.id, null,
        `Merging ${m.missionBranch} into ${m.baseBranch} conflicts in: ${res.files.join(', ')}. The merge was aborted. `
        + `Resolve the conflicts on ${m.missionBranch} (for example merge ${m.baseBranch} into it), then choose Merge again.`,
        ['OK']).catch(() => undefined);
    }
    w.entryId = this.mergeEntry(m, w.summary, res.reason).id;
    return { outcome: 'retry', reason: res.reason };
  }

  private answerQuietly(entryId: string, answer: string): void {
    try { inboxRepo.answer(this.db, entryId, answer); this.emit('inbox'); }
    catch (e) { this.warn(`answer ${entryId}: ${(e as Error).message}`); }
  }

  /** Why to give up before merging, re-checked after every await: shutdown, or a stop. */
  private halt(c: MissionCtx): BaseMergeResult | null {
    if (this.closed) return { ok: false, reason: 'Maestro is shutting down', halted: 'closed' };
    if (c.stopPromise) return { ok: false, reason: 'The mission is stopping', halted: 'stopped' };
    return null;
  }

  /** Merges the mission branch into the base branch: in the main checkout, else in a temporary worktree. */
  private async mergeIntoBase(c: MissionCtx, m: Mission): Promise<BaseMergeResult> {
    const root = c.projectRoot;
    const msg = `Maestro: ${m.title}`;
    if (this.o.beforeBaseMerge) await this.o.beforeBaseMerge();
    let h = this.halt(c);
    if (h) return h;
    const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    // Untracked files do not block the merge (a merge that would overwrite one fails, and is asked again).
    const clean = (await git(root, ['status', '--porcelain', '--untracked-files=no'])) === '';
    if ((h = this.halt(c))) return h;
    if (head === m.baseBranch && clean) return this.mergeIn(root, m.missionBranch, msg);

    const list = await git(root, ['worktree', 'list', '--porcelain']);
    if ((h = this.halt(c))) return h;
    const checkedOut = list.split(/\r?\n/).some(l => l.trim() === `branch refs/heads/${m.baseBranch}`);
    if (checkedOut) {
      return { ok: false, reason: `Check out ${m.baseBranch} or commit your changes, then choose Merge again` };
    }
    const dir = worktreeDirFor(root, c.id, `merge-${randomUUID().slice(0, 6)}`);
    await git(root, ['worktree', 'add', '--', dir, m.baseBranch]);
    try {
      if ((h = this.halt(c))) return h;
      return await this.mergeIn(dir, m.missionBranch, msg);
    } finally {
      try { await removeWorktree(root, dir); } catch (e) { this.warn(`remove merge worktree: ${(e as Error).message}`); }
    }
  }

  /** One `git merge --no-ff`: committed, or aborted (a started merge never stays half-done). */
  private async mergeIn(cwd: string, branch: string, msg: string): Promise<BaseMergeResult> {
    try {
      await git(cwd, ['merge', '--no-ff', '-m', msg, `refs/heads/${branch}`]);
      return { ok: true };
    } catch (e) {
      const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
        .split(/\r?\n/).filter(Boolean);
      await git(cwd, ['merge', '--abort']).catch(() => undefined);
      if (files.length > 0) return { ok: false, reason: `Merge conflict in ${files.join(', ')}`, files };
      return { ok: false, reason: (e as Error).message };
    }
  }

  /**
   * After merged / kept: blocked tasks (their dependency failed or was cancelled) are cancelled, the conductor ends
   * once its turn is over, and mission-level leftovers expire.
   */
  private endMission(c: MissionCtx): void {
    this.cancelBlocked(c);
    this.inbox.expireForMission(c.id);
    this.releaseConductor(c);
    this.kick();
  }

  /** The mission ended: its blocked tasks can never run, so they are cancelled. */
  private cancelBlocked(c: MissionCtx): void {
    for (const id of blockedTasks(tasks.listByMission(this.db, c.id)).keys()) {
      try { tasks.transition(this.db, id, 'cancel'); } catch (e) { this.warn(`cancel blocked task: ${(e as Error).message}`); }
      this.inbox.expireForTask(id);
    }
    this.flushEvents();
  }

  // ---- recovery (spec §12) -------------------------------------------------------

  /**
   * Startup order: construct the engine (no timers run yet), then call recover() once, before anything else:
   *   1. recoverOnStartup ends stale live session rows, rebuilds each unfinished mission's context and in-memory
   *      waits, resumes conductors (--resume, once), then resumes or re-queues their running tasks;
   *   2. only then does scheduling start (the 1 s tick and a first pass) and the 60 s stuck check.
   * The scheduler stays off while recovery runs, so a re-queued or waiting task cannot start before its mission
   * is fully recovered. Idempotent: a second call returns the first call's report.
   */
  recover(isPidAlive: (pid: number) => boolean = defaultIsPidAlive): Promise<RecoveryReport> {
    if (!this.recoverPromise) {
      this.assertOpen();
      if (this.ctxs.size > 0) {
        throw new Error('recover() must run before any mission is started or attached in this engine');
      }
      this.recovering = true;
      this.recoverPromise = recoverOnStartup(this, this.db, isPidAlive).finally(() => {
        this.recovering = false;
        if (this.closed) return;
        if (this.ctxs.size > 0) this.startTick();
        this.kick();
      });
    }
    return this.recoverPromise;
  }

  private confirmWait(p: Promise<boolean>): Promise<boolean> {
    const ms = this.o.recoveryConfirmMs ?? RECOVERY_CONFIRM_MS;
    return new Promise<boolean>(res => {
      const t = setTimeout(() => res(true), ms); // still starting: treat as resumed; an exit fails it later
      t.unref();
      p.then(ok => { clearTimeout(t); res(ok); }, () => { clearTimeout(t); res(false); });
    });
  }

  /**
   * Recovery: rebuilds the context of a mission that has not ended. Open plan_approval (awaiting_approval) and
   * merge_decision (finishing) entries get their in-memory waits back, so approvePlan / replan /
   * answerMergeDecision work and the resumed conductor's re-call re-attaches. The conductor's old questions and
   * permission requests expire: the resumed conductor asks again, and a dead process can take no answer.
   */
  async attachForRecovery(missionId: string): Promise<void> {
    this.assertOpen();
    if (this.ctxs.has(missionId)) return;
    const m = this.mission(missionId);
    const project = projects.list(this.db).find(p => p.id === m.projectId);
    if (!project) throw new Error(`Unknown project: ${m.projectId}`);
    const bridge = await this.ensureBridge();
    this.assertOpen(); // shutdown began while the bridge started: create nothing
    const c = this.createCtx(m, project.path, bridge);

    const open = inboxRepo.listOpenForMission(this.db, missionId).filter(e => e.taskId === null);
    const latest = (kind: InboxEntry['kind']): InboxEntry | undefined => open.filter(e => e.kind === kind).at(-1);
    const expire = (e: InboxEntry): void => { inboxRepo.expire(this.db, e.id); };

    const plan = latest('plan_approval');
    for (const e of open) if (e.kind === 'plan_approval' && (e !== plan || m.state !== 'awaiting_approval')) expire(e);
    if (plan && m.state === 'awaiting_approval') {
      // The plan is applied only on approval, so the wait is rebuilt from the plan text kept in the entry.
      const p = plan.payload as { planPath?: string; planMd?: string };
      const planTasks = typeof p.planMd === 'string' ? parsePlan(p.planMd) : [];
      if (p.planPath && planTasks.length > 0 && validatePlan(planTasks).length === 0) {
        c.planWait = {
          planPath: p.planPath, hash: sha256(p.planMd!), md: p.planMd!, planTasks, graph: buildGraph(planTasks),
          entryId: plan.id, d: deferred<PlanResult>(),
        };
      } else expire(plan); // the resumed conductor submits it again
    }
    if (m.state === 'running') {
      const pv = this.db.prepare(`SELECT plan_path, plan_md FROM plan_versions WHERE mission_id = ? AND approved_at IS NOT NULL
        ORDER BY version DESC LIMIT 1`).get(missionId) as { plan_path: string; plan_md: string } | undefined;
      if (pv) c.lastPlan = { planPath: pv.plan_path, hash: sha256(pv.plan_md), result: { approved: true } };
    }

    const merge = latest('merge_decision');
    for (const e of open) if (e.kind === 'merge_decision' && (e !== merge || m.state !== 'finishing')) expire(e);
    if (merge && m.state === 'finishing') {
      const summary = (merge.payload as { summary?: string }).summary ?? '';
      c.mergeWait = { entryId: merge.id, summary, merging: null, d: deferred<'merge' | 'keep'>() };
    }

    for (const e of open) if (e.kind === 'question' || e.kind === 'permission') expire(e);
    this.emit('inbox');
    this.flushEvents();
    if (m.state === 'finishing' && !c.mergeWait) await this.recoverFinishing(c, m);
  }

  /**
   * A finishing mission with no open merge_decision: Maestro died during the base merge. If the mission branch is
   * already in the base branch the merge landed, so record it. Otherwise abort any half-done merge it left and ask
   * again with a fresh merge_decision (and merge wait).
   */
  private async recoverFinishing(c: MissionCtx, m: Mission): Promise<void> {
    const root = c.projectRoot;
    const merged = await git(root, ['merge-base', '--is-ancestor', `refs/heads/${m.missionBranch}`, `refs/heads/${m.baseBranch}`])
      .then(() => true, () => false);
    this.assertOpen();
    if (merged) {
      this.transition(c.id, 'merged');
      missions.setOutcome(this.db, c.id, 'merged');
      this.emit('mission', this.mission(c.id));
      this.cancelBlocked(c);
      this.inbox.expireForMission(c.id);
      try { await removeIntegrationWorktree(root, c.id); }
      catch (e) { this.warn(`remove integration worktree: ${(e as Error).message}`); }
      return;
    }
    await this.abortHalfMerges(c, m);
    this.assertOpen();
    const prev = (this.db.prepare(`SELECT id FROM inbox WHERE mission_id = ? AND kind = 'merge_decision'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(c.id) as { id: string } | undefined);
    const summary = prev ? ((inboxRepo.get(this.db, prev.id)?.payload as { summary?: string } | null)?.summary ?? '') : '';
    const w: MergeWait = { entryId: '', summary, merging: null, d: deferred<'merge' | 'keep'>() };
    c.mergeWait = w;
    w.entryId = this.mergeEntry(m, summary, 'Maestro restarted before the merge finished. Choose again.').id;
  }

  /**
   * Aborts a merge of this mission's branch left in progress: in the main checkout only when it is on the base
   * branch and MERGE_HEAD is the mission branch tip (a merge of the user's own stays untouched), and in this
   * mission's temporary merge worktrees, which are then removed. A temp merge worktree is identified by BOTH its
   * folder name (`<mission8>-merge-<6 chars>`, as mergeIntoBase makes it) and its checked-out branch being the base
   * branch, so a task worktree whose key starts with "merge-" (on its own task branch) is never touched.
   * Stops before any changing command once shutdown has begun.
   */
  private async abortHalfMerges(c: MissionCtx, m: Mission): Promise<void> {
    const root = c.projectRoot;
    const tip = await git(root, ['rev-parse', `refs/heads/${m.missionBranch}`]).catch(() => '');
    const mergeHead = (cwd: string): Promise<string> => git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '');
    const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    if (tip && head === m.baseBranch && (await mergeHead(root)) === tip) {
      if (this.closed) return;
      await git(root, ['merge', '--abort']).catch(e => this.warn(`merge --abort: ${(e as Error).message}`));
    }
    const namePattern = new RegExp(`^${mission8(c.id)}-merge-[A-Za-z0-9-]{6}$`, 'i');
    const baseRef = `branch refs/heads/${m.baseBranch}`;
    const list = await git(root, ['worktree', 'list', '--porcelain']).catch(() => '');
    const temps: string[] = [];
    for (const block of list.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/).map(l => l.trim());
      const wt = lines.find(l => l.startsWith('worktree '));
      if (!wt) continue;
      const dir = wt.slice(9).trim();
      const name = dir.split(/[\\/]/).pop() ?? '';
      if (namePattern.test(name) && lines.includes(baseRef)) temps.push(dir);
    }
    for (const dir of temps) {
      if (this.closed) return;
      if (await mergeHead(dir)) {
        if (this.closed) return;
        await git(dir, ['merge', '--abort']).catch(() => undefined);
      }
      if (this.closed) return;
      try { await removeWorktree(root, dir); } catch (e) { this.warn(`remove merge worktree: ${(e as Error).message}`); }
    }
  }

  /** Recovery: --resume the conductor once; false (and the mission failed) when it exits before confirming. */
  async resumeConductor(missionId: string, sessionId: string): Promise<boolean> {
    this.assertOpen();
    const c = this.ctx(missionId);
    this.startConductor(c, this.mission(missionId), sessionId);
    const ok = await this.confirmWait(c.conductorResume!.d.promise);
    if (!ok && c.stopPromise) await c.stopPromise.catch(() => undefined);
    return ok;
  }

  /** Recovery: a mission whose conductor never got a session id did no conductor work: start it afresh. */
  startConductorForRecovery(missionId: string): void {
    this.assertOpen();
    const c = this.ctx(missionId);
    if (c.conductor && c.conductor.status !== 'exited') return;
    this.startConductor(c, this.mission(missionId));
  }

  /** Recovery: the task is owned by a live process elsewhere; this engine never flags or touches it. */
  holdTask(taskId: string): void { this.heldTasks.add(taskId); }

  /** Recovery: a running task with no Claude session goes back to ready (the scheduler starts it). */
  requeueTask(taskId: string): void {
    this.assertOpen();
    const t = tasks.get(this.db, taskId);
    if (!t) throw new Error(`Unknown task: ${taskId}`);
    this.ctx(t.missionId).runner.requeueAfterCrash(taskId);
    this.flushEvents();
  }

  /** Recovery: resumeAfterCrash; false when the resume failed (the task is then failed 'unrecoverable'). */
  async resumeTask(taskId: string): Promise<boolean> {
    this.assertOpen();
    const t = tasks.get(this.db, taskId);
    if (!t) throw new Error(`Unknown task: ${taskId}`);
    const runner = this.ctx(t.missionId).runner;
    await runner.resumeAfterCrash(taskId);
    const ok = await this.confirmWait(runner.whenResumed(taskId));
    this.flushEvents();
    return ok;
  }

  /**
   * Spec §12: one "<KEY> seems stuck" question per running task with no event for stuckAfterMs, with the options
   * Stop task (stops the task) and Keep waiting (no new entry for that task until another stuckAfterMs passes).
   * Never duplicates an open stuck entry. Runs every 60 s; public so tests can pass `now`.
   */
  checkStuckTasks(now: number = Date.now()): void {
    if (this.closed || this.recovering) return;
    const after = this.o.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
    for (const id of checkStuck(this.db, now, after)) {
      if (this.stuckOpen.has(id) || this.heldTasks.has(id)) continue;
      if ((this.stuckSnoozed.get(id) ?? 0) > now) continue;
      const t = tasks.get(this.db, id);
      const c = t && this.ctxs.get(t.missionId);
      if (!t || !c || c.stopPromise) continue;
      const minutes = Math.max(1, Math.round((now - lastActivity(this.db, id)) / 60_000));
      const question = `${t.taskKey} seems stuck — no activity for ${minutes} minutes`;
      this.stuckOpen.add(id);
      const asked = this.inbox.ask(t.missionId, id, question, [STOP_TASK, KEEP_WAITING]);
      asked.then(answer => {
        this.stuckOpen.delete(id);
        if (this.closed) return;
        if (answer === STOP_TASK) {
          c.runner.stop(id).catch(e => this.warn(`stop ${t.taskKey}: ${(e as Error).message}`));
        } else {
          this.stuckSnoozed.set(id, Date.now() + after);
        }
      }, () => { this.stuckOpen.delete(id); }); // expired (the task ended or was resumed) or shutdown
    }
  }

  // ---- stop / shutdown ---------------------------------------------------------

  /** Stops every task run and the conductor, expires open entries, mission `stop`. Idempotent. */
  stop(missionId: string): Promise<void> {
    const c = this.ctxs.get(missionId);
    if (!c) return Promise.reject(new Error(`Unknown mission: ${missionId}`));
    if (!c.stopPromise && this.closed) return Promise.reject(new Error(SHUTTING_DOWN)); // shutdown writes no states
    // Set before runStop starts, so every handler sees the stop at once.
    if (!c.stopPromise) c.stopPromise = Promise.resolve().then(() => this.runStop(c));
    return c.stopPromise;
  }

  /**
   * Like stop(), but the mission ends `failed` and a 'mission-failed' event records why. Tasks keep their worktrees
   * and branches; live task runs are stopped (cancelled) so nothing stays half-alive.
   */
  private failMission(c: MissionCtx, reason: string): Promise<void> {
    if (c.stopPromise) return c.stopPromise;
    if (this.closed) return Promise.resolve();
    c.stopPromise = Promise.resolve().then(() => this.runStop(c, 'fail', reason));
    return c.stopPromise;
  }

  private async runStop(c: MissionCtx, ev: 'stop' | 'fail' = 'stop', reason?: string): Promise<void> {
    // A base merge in flight finishes first: the mission then ends merged, or stops with the base untouched.
    const merging = c.mergeWait?.merging;
    if (merging) await merging.catch(() => undefined);
    const stopped = new Error('The mission was stopped');
    if (c.planWait) { const w = c.planWait; c.planWait = null; w.d.reject(stopped); }
    if (c.mergeWait) { const w = c.mergeWait; c.mergeWait = null; w.d.reject(stopped); }
    const ended = missions.get(this.db, c.id);
    if (!ended || TERMINAL_MISSION_STATES.has(ended.state)) {
      // Already done (e.g. merged): leave its tasks alone, just make sure the conductor is gone.
      if (c.lingerTimer) { clearTimeout(c.lingerTimer); c.lingerTimer = null; }
      if (c.conductor) await c.conductor.stop(this.o.stopTimeoutMs ?? 5000).catch(() => undefined);
      return;
    }
    const list = tasks.listByMission(this.db, c.id);
    await Promise.all(list.filter(t => LIVE_TASK_STATES.has(t.state)).map(t =>
      c.runner.stop(t.id).catch(e => this.warn(`stop ${t.taskKey}: ${(e as Error).message}`))));
    if (c.lingerTimer) { clearTimeout(c.lingerTimer); c.lingerTimer = null; }
    if (c.conductor) {
      try { await c.conductor.stop(this.o.stopTimeoutMs ?? 5000); }
      catch (e) { this.warn(`conductor stop: ${(e as Error).message}`); }
    }
    this.inbox.expireForMission(c.id);
    for (const t of list) this.inbox.expireForTask(t.id);
    const m = missions.get(this.db, c.id);
    if (m && !TERMINAL_MISSION_STATES.has(m.state)) {
      this.transition(c.id, ev);
      if (ev === 'fail') this.appendEvent(c.id, 'mission-failed', { reason });
    }
    for (const w of [...this.waiters]) w.check();
    this.flushEvents();
  }

  /** Stops every mission that has not ended (e.g. for tests). Unlike shutdown(), this changes states. */
  async stopAll(): Promise<void> {
    this.assertOpen();
    await Promise.all([...this.ctxs.values()].map(async c => {
      const m = missions.get(this.db, c.id);
      if (m && !TERMINAL_MISSION_STATES.has(m.state)) await this.stop(c.id).catch(() => undefined);
    }));
  }

  /**
   * App shutdown. Changes no mission, task or inbox state of its own: every handler and mutator refuses at once,
   * an in-flight base merge or stop is awaited (bounded), pending handler calls are rejected in memory, the
   * conductors are killed and the bridge closes, then every task process is killed (only session rows end,
   * 'live' to 'ended') so recovery can resume them. Nothing is written after it resolves. Idempotent.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    this.closed = true;
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    if (this.stuckTimer) { clearInterval(this.stuckTimer); this.stuckTimer = null; }
    const all = [...this.ctxs.values()];
    // In-flight work that writes the database settles first (a merge bails out at its next check unless git is
    // already merging; a stop finishes its transitions).
    await Promise.all(all.map(c => bounded(Promise.all([
      c.mergeWait?.merging?.catch(() => undefined), c.stopPromise?.catch(() => undefined),
    ]), SHUTDOWN_WAIT_MS)));
    const err = new Error('Maestro is shutting down');
    for (const c of all) {
      if (c.lingerTimer) { clearTimeout(c.lingerTimer); c.lingerTimer = null; }
      if (c.planWait) { const w = c.planWait; c.planWait = null; w.d.reject(err); }
      if (c.mergeWait) { const w = c.mergeWait; c.mergeWait = null; w.d.reject(err); }
    }
    for (const w of [...this.waiters]) w.fail(err);
    this.inbox.detachPending(err);
    // Conductors and the bridge go first, so nothing can call in while the tasks are detached.
    const b = this.bridge;
    this.bridge = null;
    await Promise.all([
      ...all.map(async c => {
        c.detached = true;
        const rowId = c.conductorRowId;
        if (rowId) {
          this.registry.delete(rowId);
          if (sessions.listLive(this.db).some(s => s.id === rowId)) sessions.end(this.db, rowId, 'ended');
        }
        if (c.conductor && c.conductor.status !== 'exited') {
          await c.conductor.kill().catch(e => this.warn(`conductor kill: ${(e as Error).message}`));
        }
      }),
      b ? b.then(x => x.close(), () => undefined) : Promise.resolve(),
    ]);
    await Promise.all(all.map(async c => {
      await c.runner.detachAll().catch(e => this.warn(`detach tasks: ${(e as Error).message}`));
      c.runner.dispose();
    }));
    // A recovery in progress sees `closed` after its current await and stops without writing; let it settle.
    if (this.recoverPromise) await bounded(this.recoverPromise, SHUTDOWN_WAIT_MS);
  }
}

/** Resolves when p settles or after ms, whichever comes first. */
function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>(res => {
    const t = setTimeout(res, ms);
    t.unref();
    p.then(() => { clearTimeout(t); res(); }, () => { clearTimeout(t); res(); });
  });
}
