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
import { buildGraph } from '../core/plan/graph.js';
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

const execFileP = promisify(execFile);

const DEFAULT_PROMPT_FILE = fileURLToPath(new URL('../../prompts/conductor.md', import.meta.url));
const TICK_MS = 1000;
const PROGRESS_MS = 60_000;
/** After the mission ends, the conductor gets this long to finish its turn before it is stopped. */
const CONDUCTOR_LINGER_MS = 120_000;
export const MERGE = 'Merge';
export const KEEP = 'Keep branch';
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

type PlanResult = { errors: PlanError[] } | { approved: true } | { approved: false; note: string };

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => undefined); // a rejection nobody awaits must not crash the host
  return { promise, resolve, reject };
}

interface PlanWait { planPath: string; hash: string; versionId: string; entryId: string; d: Deferred<PlanResult> }
interface MergeWait {
  entryId: string; summary: string; d: Deferred<'merge' | 'keep'>;
  /** The base merge in flight (stop() waits for it). */
  merging: Promise<MergeDecisionResult> | null;
}

interface MissionCtx {
  id: string;
  projectRoot: string;
  runner: TaskRunner;
  conductor: ClaudeSession | null;
  conductorRowId: string | null;
  subagentUses: number;
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
    if (this.tick) return;
    this.tick = setInterval(() => this.kick(), TICK_MS);
    this.tick.unref();
  }

  async startMission(input: StartMissionInput): Promise<Mission> {
    if (this.closed) throw new Error('The mission engine is closed');
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
      const missionDir = join(this.o.logDir, 'missions', m.id);
      const conductorCfg = writeBridgeConfig(missionDir, {
        port: bridge.port, token: bridge.token, missionId: m.id, tools: 'conductor',
      });
      const runner = new TaskRunner({
        db: this.db, inbox: this.inbox, registry: this.registry, projectRoot: root, missionBranch: branch,
        bridgeAskConfig: taskId => writeBridgeConfig(join(this.o.logDir, 'tasks', taskId), {
          port: bridge.port, token: bridge.token, missionId: m.id, taskId, tools: 'task',
        }),
        logDir: join(missionDir, 'tasks'), exe: this.o.exe, command: this.o.command, env: this.o.env,
        rolesDir: this.o.rolesDir, stopTimeoutMs: this.o.stopTimeoutMs,
      });
      const c: MissionCtx = {
        id: m.id, projectRoot: root, runner, conductor: null, conductorRowId: null, subagentUses: 0,
        planWait: null, lastPlan: null, mergeWait: null, stopPromise: null, lingerTimer: null, detached: false,
      };
      this.ctxs.set(m.id, c);
      runner.on('state', () => { this.flushEvents(); this.kick(); });
      runner.on('finished', (_f: TaskFinished) => { this.flushEvents(); this.kick(); });

      m = this.transition(m.id, quick || input.depth === 'quick' ? 'start_quick' : 'start');
      this.startConductor(c, m, conductorCfg, missionDir);
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

  /** Spec §7.1. The brief and settings are the first user message. */
  private startConductor(c: MissionCtx, m: Mission, bridgeCfg: string, missionDir: string): void {
    mkdirSync(missionDir, { recursive: true });
    const args = [
      '--model', 'opus',
      '--mcp-config', bridgeCfg,
      '--append-system-prompt-file', this.o.conductorPromptFile ?? DEFAULT_PROMPT_FILE,
      '--permission-mode', 'default',
      // As in the R1 runs: the bridge's own tools never prompt (every other tool does).
      '--allowedTools', 'mcp__maestro__*',
    ];
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
    const row = sessions.start(this.db, { missionId: m.id, taskId: null, role: 'conductor', pid: session.pid, logPath });
    c.conductorRowId = row.id;
    this.registry.set(row.id, session);
    session.send(this.missionBrief(m));
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
    switch (ev.kind) {
      case 'init':
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
        return;
      case 'permission-request':
        if (c.conductorRowId && !c.stopPromise) this.inbox.onPermissionRequest(c.id, null, c.conductorRowId, ev);
        return;
      case 'permission-cancel':
        this.inbox.onPermissionCancel(ev.requestId);
        return;
      case 'result':
        if (c.lingerTimer) this.closeConductor(c); // the mission ended; this was the conductor's last turn
        return;
      default:
        return; // rate-limit events are handled for every session via the registry
    }
  }

  private onConductorExit(c: MissionCtx, code: number | null): void {
    if (c.detached) return; // shutdown() ended the row itself and changes nothing else
    if (c.conductorRowId) {
      this.registry.delete(c.conductorRowId);
      try { sessions.end(this.db, c.conductorRowId, code === 0 ? 'ended' : 'failed'); } catch { /* already ended */ }
    }
    if (c.lingerTimer) { clearTimeout(c.lingerTimer); c.lingerTimer = null; }
    const m = missions.get(this.db, c.id);
    if (!m || TERMINAL_MISSION_STATES.has(m.state) || c.stopPromise) return;
    // Spec §12 restart-with-resume belongs to recovery (a later task); record it so it is visible.
    this.appendEvent(c.id, 'conductor-exited', { code });
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
      if (ev.kind !== 'rate-limit') return;
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

  async submitPlan(missionId: string, planPath: string): Promise<PlanResult> {
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

    const conflictErrors = (keys: string[]): { errors: PlanError[] } => ({
      errors: keys.map(k => ({ code: 'duplicate-key' as const, taskKeys: [k], message: `${k} conflicts with an existing task; rename it` })),
    });
    const existing = tasks.listByMission(this.db, missionId);
    const byKey = new Map(existing.map(t => [t.taskKey, t]));
    const conflicts = planTasks.filter(t => {
      const cur = byKey.get(t.key);
      return cur !== undefined && (cur.planVersionId === null || cur.state === 'cancelled');
    }).map(t => t.key);
    if (conflicts.length > 0) return conflictErrors(conflicts);

    // Plan version and tasks in one transaction: a conflict rolls both back, so no orphan version remains.
    const graph = buildGraph(planTasks);
    class Conflict extends Error { constructor(public keys: string[]) { super('conflict'); } }
    let applied: { pvId: string; version: number; cancelled: string[]; runningUnplanned: string[] };
    try {
      applied = this.db.transaction(() => {
        const max = (this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM plan_versions WHERE mission_id = ?')
          .get(missionId) as { v: number }).v;
        const pv = planVersions.create(this.db, { missionId, version: max + 1, planPath: abs, planMd: md });
        if (max === 0 && existing.length === 0) {
          tasks.insertPlan(this.db, missionId, pv.id, planTasks, graph);
          return { pvId: pv.id, version: max + 1, cancelled: [], runningUnplanned: [] };
        }
        const r = tasks.applyReplan(this.db, missionId, pv.id, planTasks, graph);
        if (r.conflicts.length > 0) throw new Conflict(r.conflicts);
        return { pvId: pv.id, version: max + 1, cancelled: r.cancelled, runningUnplanned: r.runningUnplanned };
      })();
    } catch (e) {
      if (e instanceof Conflict) return conflictErrors(e.keys);
      throw e;
    }

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
      planVersionId: applied.pvId, version: applied.version, planPath: abs, taskKeys: planTasks.map(t => t.key),
      waves: graph.waves, criticalPath: graph.criticalPath,
      cancelled: applied.cancelled, runningUnplanned: applied.runningUnplanned,
    });
    const d = deferred<PlanResult>();
    c.planWait = { planPath: abs, hash, versionId: applied.pvId, entryId: entry.id, d };
    this.kick();
    return d.promise;
  }

  approvePlan(missionId: string): void {
    const c = this.ctx(missionId);
    const w = c.planWait;
    if (!w) throw new Error(`Mission ${missionId} has no plan waiting for approval`);
    this.transition(missionId, 'approve'); // first: an illegal transition leaves the entry open
    inboxRepo.answer(this.db, w.entryId, { approved: true });
    planVersions.approve(this.db, w.versionId);
    c.planWait = null;
    c.lastPlan = { planPath: w.planPath, hash: w.hash, result: { approved: true } };
    this.emit('inbox');
    w.d.resolve({ approved: true });
    this.kick();
  }

  replan(missionId: string, note: string): void {
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

  async dispatchTask(missionId: string, d: DispatchInput): Promise<{ task_ref: string }> {
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
    if (this.closed) return;
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

  async waitForTasks(missionId: string, refs: string[], mode: 'all' | 'any', onProgress: () => void): Promise<TaskSummary[]> {
    const c = this.ctx(missionId);
    for (const r of refs) this.ownTask(missionId, r);
    const isDone = (): boolean => {
      if (refs.length === 0) return true;
      const states = refs.map(r => tasks.get(this.db, r)?.state ?? 'cancelled');
      return mode === 'any' ? states.some(s => WAIT_TERMINAL.has(s)) : states.every(s => WAIT_TERMINAL.has(s));
    };
    if (!isDone()) {
      if (this.closed) throw new Error('Maestro is shutting down');
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
    const status: TaskSummary['status'] = t.state === 'done' || t.state === 'failed' || t.state === 'cancelled' ? t.state : 'running';
    return {
      task_ref: t.id, key: t.taskKey, status, handoff: t.handoffMd, branch: t.branch, commits,
      failure_reason: t.failureReason,
    };
  }

  // ---- ask_user ----------------------------------------------------------------

  async askUser(missionId: string, taskId: string | null, q: { question: string; options?: string[]; context?: string }): Promise<string> {
    const c = this.ctx(missionId);
    if (taskId !== null) this.ownTask(missionId, taskId);
    if (c.stopPromise) throw new Error('The mission is stopping');
    const text = q.context?.trim() ? `${q.question}\n\nContext: ${q.context.trim()}` : q.question;
    const options = q.options && q.options.length > 0 ? q.options : undefined;
    return this.inbox.ask(missionId, taskId, text, options);
  }

  // ---- finish_mission ----------------------------------------------------------

  async finishMission(missionId: string, summary: string): Promise<'merge' | 'keep'> {
    const c = this.ctx(missionId);
    if (c.stopPromise) throw new Error('The mission is stopping');
    if (c.mergeWait) return c.mergeWait.d.promise; // idempotent re-call
    const m = this.mission(missionId);
    if (m.state !== 'running') throw new Error(`Cannot finish the mission while it is ${m.state}`);
    const active = tasks.listByMission(this.db, missionId).filter(t =>
      ACTIVE_TASK_STATES.has(t.state) || (t.state === 'planned' && t.dispatchedAt !== null));
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
    inboxRepo.answer(this.db, entryId, answer);
    this.emit('inbox');
    const m = this.mission(c.id);

    if (answer === KEEP) {
      this.transition(c.id, 'kept');
      missions.setOutcome(this.db, c.id, 'kept');
      this.emit('mission', this.mission(c.id));
      this.endMission(c);
      w.d.resolve('keep');
      return { outcome: 'kept' };
    }

    // stop() waits for this promise before it changes anything.
    const merging = this.runMerge(c, w, m);
    w.merging = merging;
    try { return await merging; } finally { w.merging = null; }
  }

  private async runMerge(c: MissionCtx, w: MergeWait, m: Mission): Promise<MergeDecisionResult> {
    let res: { ok: true } | { ok: false; reason: string; files?: string[] };
    try { res = await this.mergeIntoBase(c, m); }
    catch (e) { res = { ok: false, reason: (e as Error).message }; }

    if (res.ok) {
      // The base branch now has the work: record it even if a stop arrived meanwhile (stop waits for us).
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
    if (c.stopPromise || this.mission(c.id).state !== 'finishing') return { outcome: 'stopped' };
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

  /** Merges the mission branch into the base branch: in the main checkout, else in a temporary worktree. */
  private async mergeIntoBase(c: MissionCtx, m: Mission): Promise<{ ok: true } | { ok: false; reason: string; files?: string[] }> {
    const root = c.projectRoot;
    const msg = `Maestro: ${m.title}`;
    const stopped = { ok: false as const, reason: 'The mission is stopping' };
    if (this.o.beforeBaseMerge) await this.o.beforeBaseMerge();
    if (c.stopPromise) return stopped;
    const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    const clean = (await git(root, ['status', '--porcelain'])) === '';
    if (c.stopPromise) return stopped;
    if (head === m.baseBranch && clean) return this.mergeIn(root, m.missionBranch, msg);

    const list = await git(root, ['worktree', 'list', '--porcelain']);
    const checkedOut = list.split(/\r?\n/).some(l => l.trim() === `branch refs/heads/${m.baseBranch}`);
    if (checkedOut) {
      return { ok: false, reason: `Check out ${m.baseBranch} or commit your changes, then choose Merge again` };
    }
    const dir = worktreeDirFor(root, c.id, `merge-${randomUUID().slice(0, 6)}`);
    await git(root, ['worktree', 'add', '--', dir, m.baseBranch]);
    try {
      if (c.stopPromise) return stopped;
      return await this.mergeIn(dir, m.missionBranch, msg);
    } finally {
      try { await removeWorktree(root, dir); } catch (e) { this.warn(`remove merge worktree: ${(e as Error).message}`); }
    }
  }

  private async mergeIn(cwd: string, branch: string, msg: string): Promise<{ ok: true } | { ok: false; reason: string; files?: string[] }> {
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

  /** After merged / kept: the conductor ends once its turn is over; mission-level leftovers expire. */
  private endMission(c: MissionCtx): void {
    this.inbox.expireForMission(c.id);
    this.releaseConductor(c);
    this.kick();
  }

  // ---- stop / shutdown ---------------------------------------------------------

  /** Stops every task run and the conductor, expires open entries, mission `stop`. Idempotent. */
  stop(missionId: string): Promise<void> {
    const c = this.ctxs.get(missionId);
    if (!c) return Promise.reject(new Error(`Unknown mission: ${missionId}`));
    // Set before runStop starts, so every handler sees the stop at once.
    if (!c.stopPromise) c.stopPromise = Promise.resolve().then(() => this.runStop(c));
    return c.stopPromise;
  }

  private async runStop(c: MissionCtx): Promise<void> {
    // A base merge in flight finishes first: the mission then ends merged, or stops with the base untouched.
    const merging = c.mergeWait?.merging;
    if (merging) await merging.catch(() => undefined);
    const stopped = new Error('The mission was stopped');
    if (c.planWait) { const w = c.planWait; c.planWait = null; w.d.reject(stopped); }
    if (c.mergeWait) { const w = c.mergeWait; c.mergeWait = null; w.d.reject(stopped); }
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
    if (m && !TERMINAL_MISSION_STATES.has(m.state)) this.transition(c.id, 'stop');
    for (const w of [...this.waiters]) w.check();
    this.flushEvents();
  }

  /** Stops every mission that has not ended (e.g. for tests). Unlike shutdown(), this changes states. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.ctxs.values()].map(async c => {
      const m = missions.get(this.db, c.id);
      if (m && !TERMINAL_MISSION_STATES.has(m.state)) await this.stop(c.id).catch(() => undefined);
    }));
  }

  /**
   * App shutdown. Changes no mission, task or inbox state: pending handler calls are rejected in memory, every live
   * conductor and task process is killed and only its session row ends ('live' to 'ended'), so recovery can resume
   * them. Then the runners are disposed and the bridge closes. Idempotent.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    this.closed = true;
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    const err = new Error('Maestro is shutting down');
    for (const c of this.ctxs.values()) {
      if (c.lingerTimer) { clearTimeout(c.lingerTimer); c.lingerTimer = null; }
      if (c.planWait) { const w = c.planWait; c.planWait = null; w.d.reject(err); }
      if (c.mergeWait) { const w = c.mergeWait; c.mergeWait = null; w.d.reject(err); }
    }
    for (const w of [...this.waiters]) w.fail(err);
    this.inbox.detachPending(err);
    await Promise.all([...this.ctxs.values()].map(async c => {
      await c.runner.detachAll().catch(e => this.warn(`detach tasks: ${(e as Error).message}`));
      c.detached = true;
      const rowId = c.conductorRowId;
      if (rowId) {
        this.registry.delete(rowId);
        if (sessions.listLive(this.db).some(s => s.id === rowId)) sessions.end(this.db, rowId, 'ended');
      }
      if (c.conductor && c.conductor.status !== 'exited') {
        await c.conductor.kill().catch(e => this.warn(`conductor kill: ${(e as Error).message}`));
      }
      c.runner.dispose();
    }));
    const b = this.bridge;
    this.bridge = null;
    if (b) await b.then(x => x.close(), () => undefined);
  }
}
