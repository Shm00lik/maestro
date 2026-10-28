// Runs one task's whole lifecycle (spec §8.1, §8.3, §9): worktree, claude session with the role's settings,
// permissions to the inbox, completion via the `## Handoff` section, merge into the mission branch, stop and recovery.
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../store/db.js';
import { events, inbox as inboxRepo, sessions, tasks, type Task } from '../store/repos.js';
import type { TaskEvent } from '../core/state/taskMachine.js';
import { AGENT_ROLES, type AgentRole } from '../core/types.js';
import { ClaudeSession, SessionClosed } from '../claude/session.js';
import { lastHandoff, type StreamEvent } from '../claude/protocol.js';
import {
  addExistingBranchWorktree, branchExists, createTaskWorktree, isRegisteredWorktree, mergeTaskBranch, pruneWorktrees,
  worktreeDirFor,
} from '../git/worktrees.js';
import type { InboxChanged, InboxService, SessionRegistry } from './inbox.js';

const execFileP = promisify(execFile);

export const HANDOFF_REMINDER = 'Finish with a ## Handoff section.';
export const RESUME_MESSAGE =
  'Maestro restarted while you were working. Any question you were waiting on was interrupted: ask it again. '
  + 'Then continue the task where you left off and finish with a ## Handoff section.';
/** Tools of Maestro's own bridge MCP server (named `maestro` in the bridge config). Any other mcp__* tool is unsafe. */
export const BRIDGE_TOOL_PREFIX = 'mcp__maestro__';
const CLOSE_WAIT_MS = 10_000;
const DETACHED = '\u0000detached';
const CRASH_LOG_LINES = 50;
const CRASH_LOG_MAX = 4096;
/** A task's stream activity is recorded as an 'activity' event at most this often (stuck detection reads it). */
const ACTIVITY_EVERY_MS = 60_000;
/** failureReason of a task whose `--resume` process could not continue its session. */
export const UNRECOVERABLE = 'unrecoverable';

export type RoleModel = 'opus' | 'sonnet' | 'haiku';
export interface RoleConfig {
  name: AgentRole;
  model: RoleModel;
  /** Explicit built-in allow-list (`--tools`), set for read-only roles (R7). */
  tools?: string[];
  deniedTools: string[];
  body: string;
}

export interface TaskRunnerDeps {
  db: Db;
  inbox: InboxService;
  projectRoot: string;
  missionBranch: string;
  /** Path of the task's bridge MCP config (only `ask_user`). */
  bridgeAskConfig: (taskId: string) => string;
  logDir: string;
  /** claude.exe path; ignored when `command` is given. */
  exe?: string;
  /** Full command override (tests: node + tsx + fake-claude). */
  command?: { exe: string; prefixArgs: string[] };
  /** Extra env for every session. */
  env?: Record<string, string>;
  /** Live sessions by session row id; pass the same instance to InboxService. Created when omitted. */
  registry?: LiveSessionRegistry;
  /** Directory with the role files; defaults to `<maestro>/agents`. */
  rolesDir?: string;
  stopTimeoutMs?: number;
  /** Minimum gap between 'activity' events of one task (default 60 s). */
  activityEveryMs?: number;
}

export interface TaskFinished { taskId: string; outcome: 'done' | 'failed' | 'cancelled'; reason?: string }

/** SessionRegistry for InboxService, filled by the runner with its live sessions. */
export class LiveSessionRegistry implements SessionRegistry {
  private map = new Map<string, ClaudeSession>();
  get(sessionRowId: string): ClaudeSession | undefined { return this.map.get(sessionRowId); }
  set(sessionRowId: string, s: ClaudeSession): void { this.map.set(sessionRowId, s); }
  delete(sessionRowId: string): void { this.map.delete(sessionRowId); }
  get size(): number { return this.map.size; }
}

// ---- roles -----------------------------------------------------------------

const DEFAULT_ROLES_DIR = fileURLToPath(new URL('../../agents/', import.meta.url));
const MODELS: readonly string[] = ['opus', 'sonnet', 'haiku'];

function parseList(v: string): string[] {
  const s = v.trim().replace(/^\[/, '').replace(/\]$/, '');
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

/** Reads agents/<name>.md: YAML-ish front matter (`model`, `tools`, `denied_tools`) and the body (system prompt). */
export function loadRole(name: AgentRole, dir: string = DEFAULT_ROLES_DIR): RoleConfig {
  if (!(AGENT_ROLES as readonly string[]).includes(name)) throw new Error(`Unknown agent role: ${name}`);
  const file = join(dir, `${name}.md`);
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`Role file ${file} has no front matter`);
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (fm.name !== undefined && fm.name !== name) throw new Error(`Role file ${file} names role "${fm.name}", expected "${name}"`);
  if (!MODELS.includes(fm.model)) throw new Error(`Role file ${file} has invalid model "${fm.model ?? ''}" (opus, sonnet or haiku)`);
  const role: RoleConfig = { name, model: fm.model as RoleModel, deniedTools: parseList(fm.denied_tools ?? ''), body: m[2].trim() };
  if (fm.tools !== undefined) role.tools = parseList(fm.tools);
  return role;
}

/** claude args after BASE_ARGS (spec §8.1 with the R7 decision). The prompt itself is sent as the first user message. */
export function buildTaskArgs(role: RoleConfig, systemPromptFile: string, bridgeConfigPath: string, resumeSessionId?: string): string[] {
  const args = ['--model', role.model];
  if (role.tools) args.push('--tools', role.tools.join(','));
  if (role.deniedTools.length > 0) args.push('--disallowedTools', role.deniedTools.join(','));
  args.push(
    '--append-system-prompt-file', systemPromptFile,
    '--strict-mcp-config', '--mcp-config', bridgeConfigPath,
    '--permission-mode', 'acceptEdits',
  );
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  return args;
}

/**
 * Tools from `init` the session must not have: any mcp__* tool not from Maestro's bridge (all roles), and for roles
 * with an explicit `tools` allow-list, any other tool not on that list.
 */
export function unsafeTools(role: RoleConfig, tools: string[]): string[] {
  return tools.filter(t => {
    if (t.startsWith(BRIDGE_TOOL_PREFIX)) return false;
    if (t.startsWith('mcp__')) return true;
    return role.tools !== undefined && !role.tools.includes(t);
  });
}

export function buildTaskPrompt(task: Task, upstream: { key: string; handoff: string }[]): string {
  const parts = [task.prompt.trim()];
  if (upstream.length > 0) {
    parts.push('## Upstream handoffs\n\n' + upstream.map(u => `### ${u.key} handoff\n${u.handoff.trim()}`).join('\n\n'));
  }
  if (task.acceptance.trim()) parts.push(`## Acceptance criteria\n\n${task.acceptance.trim()}`);
  parts.push('## When you finish\n\nCommit your work on this branch. End your final message with a `## Handoff` section '
    + 'listing what you made, the decisions you took, and your test evidence.');
  return parts.join('\n\n');
}

// ---- runner ----------------------------------------------------------------


type Phase = 'starting' | 'running' | 'finishing' | 'failing' | 'stopping' | 'ended';
/** Who started a turn: Maestro (prompt, reminder, resume nudge) or the user (`message()`). */
type TurnOrigin = 'maestro' | 'user';
const TERMINAL: readonly string[] = ['done', 'failed', 'cancelled'];

interface Run {
  taskId: string;
  missionId: string;
  role: RoleConfig | null;
  phase: Phase;
  session: ClaudeSession | null;
  rowId: string | null;
  rowEnded: boolean;
  logPath: string | null;
  reminded: boolean;
  /** Origins of the messages sent since the last result. */
  turns: TurnOrigin[];
  lastAssistantText: string;
  lastError: string | null;
  finished: boolean;
  /** Set by detach(): a completion that has not started merging stops without any state change. */
  detached: boolean;
  /** Set synchronously by stop(); start/resume check it before spawning. */
  stopRequested: boolean;
  /** Settles when start/resume finished spawning (or failed). */
  ready: Promise<void>;
  stopPromise: Promise<void> | null;
  /** Settles when finishing (close + merge) is over. Never rejects. */
  finishing: Promise<void> | null;
  /** Settles when failing (incl. stopping the process) is over. Never rejects. */
  failing: Promise<void> | null;
  /** resumeAfterCrash: the session id being resumed, until an init with that id or a result confirms it. */
  resumeId: string | null;
  /** Settles true when the resume is confirmed, false when the run ends first. */
  resumeConfirm: { promise: Promise<boolean>; resolve(ok: boolean): void } | null;
  lastActivityAt: number;
}

export class TaskRunner extends EventEmitter {
  readonly registry: LiveSessionRegistry;
  private runs = new Map<string, Run>();
  /** resumeAfterCrash confirmations by task id, kept after they settle so whenResumed never races them. */
  private resumes = new Map<string, Promise<boolean>>();
  private readonly onInboxChanged = (e: InboxChanged): void => this.inboxChanged(e);

  constructor(private deps: TaskRunnerDeps) {
    super();
    this.registry = deps.registry ?? new LiveSessionRegistry();
    deps.inbox.on('changed', this.onInboxChanged);
  }

  dispose(): void { this.deps.inbox.off('changed', this.onInboxChanged); }

  private get db(): Db { return this.deps.db; }

  private warn(msg: string): void { console.error(`[maestro task-runner] ${msg}`); }

  /** Runs fn; logs instead of throwing. */
  private safe(label: string, fn: () => void): void {
    try { fn(); } catch (e) { this.warn(`${label}: ${(e as Error)?.message ?? String(e)}`); }
  }

  private task(id: string): Task {
    const t = tasks.get(this.db, id);
    if (!t) throw new Error(`Task not found: ${id}`);
    return t;
  }

  private transition(id: string, ev: TaskEvent): Task {
    const t = tasks.transition(this.db, id, ev);
    this.emit('state', t);
    return t;
  }

  private newRun(task: Task): Run {
    const prev = this.runs.get(task.id);
    if (prev && prev.phase !== 'ended') throw new Error(`Task ${task.taskKey} is already running`);
    const run: Run = {
      taskId: task.id, missionId: task.missionId, role: null, phase: 'starting', session: null, rowId: null,
      rowEnded: false, logPath: null, reminded: false, turns: [], lastAssistantText: '', lastError: null,
      finished: false, detached: false, stopRequested: false, ready: Promise.resolve(), stopPromise: null, finishing: null, failing: null,
      resumeId: null, resumeConfirm: null, lastActivityAt: 0,
    };
    this.runs.set(task.id, run);
    return run;
  }

  private holdReady(run: Run): () => void {
    let release!: () => void;
    run.ready = new Promise<void>(r => { release = r; });
    return release;
  }

  async start(taskId: string, upstreamHandoffs: { key: string; handoff: string }[]): Promise<void> {
    const task = this.task(taskId);
    if (task.state !== 'ready') throw new Error(`Task ${task.taskKey} is ${task.state}, expected ready`);
    const run = this.newRun(task);
    const release = this.holdReady(run);
    try {
      this.transition(taskId, 'start');
      let role: RoleConfig;
      try { role = loadRole(task.agent as AgentRole, this.deps.rolesDir); }
      catch (e) { await this.fail(run, `unknown-agent: ${(e as Error).message}`); return; }
      run.role = role;
      const branch = `${this.deps.missionBranch}--${task.taskKey}`;
      let dir: string;
      try { dir = await this.ensureWorktree(task, branch); }
      catch (e) { await this.fail(run, `worktree: ${(e as Error).message}`); return; }
      tasks.setRuntime(this.db, taskId, { worktreePath: dir, branch });
      if (run.stopRequested) return; // stop() cancels it once ready settles
      this.spawn(run, role, dir);
      this.sendOwn(run, buildTaskPrompt(task, upstreamHandoffs));
    } catch (e) {
      if (run.phase === 'starting' || run.phase === 'running') await this.fail(run, `start: ${(e as Error).message}`);
      else this.warn(`start ${task.taskKey}: ${(e as Error).message}`);
    } finally {
      release();
    }
  }

  /** Recovery only: the app restarted while the task was running. Starts a new process with `--resume <sessionId>`. */
  async resumeAfterCrash(taskId: string): Promise<void> {
    let task = this.task(taskId);
    if (task.state !== 'running' && task.state !== 'needs_you') throw new Error(`Task ${task.taskKey} is ${task.state}, not running`);
    const run = this.newRun(task);
    let confirm!: (ok: boolean) => void;
    const confirmed = new Promise<boolean>(r => { confirm = r; });
    run.resumeConfirm = { promise: confirmed, resolve: confirm };
    this.resumes.set(taskId, confirmed);
    run.resumeId = task.sessionId;
    const release = this.holdReady(run);
    try {
      // The old process is gone: its permission requests can never be answered.
      this.endLiveRows(taskId, 'failed');
      this.deps.inbox.expireForTask(taskId);
      task = this.task(taskId);
      if (task.state === 'needs_you') task = this.transition(taskId, 'answered');
      if (!task.sessionId || !task.worktreePath || !existsSync(task.worktreePath)) {
        await this.failUnrecoverable(run, 'no session or worktree to resume');
        return;
      }
      let role: RoleConfig;
      try { role = loadRole(task.agent as AgentRole, this.deps.rolesDir); }
      catch (e) { await this.fail(run, `unknown-agent: ${(e as Error).message}`); return; }
      run.role = role;
      if (run.stopRequested || run.detached) return;
      this.spawn(run, role, task.worktreePath, task.sessionId);
      this.sendOwn(run, RESUME_MESSAGE);
    } catch (e) {
      if (run.phase === 'starting' || run.phase === 'running') await this.failUnrecoverable(run, `resume: ${(e as Error).message}`);
      else this.warn(`resume ${task.taskKey}: ${(e as Error).message}`);
    } finally {
      release();
    }
  }

  /**
   * After resumeAfterCrash: true once the resumed process confirmed the session (an init with the same session id,
   * or a result), false when the run ended first (it then failed with reason 'unrecoverable', or was stopped).
   */
  whenResumed(taskId: string): Promise<boolean> {
    return this.resumes.get(taskId) ?? Promise.resolve(false);
  }

  /**
   * Recovery only: the task was running but never got a Claude session (the app stopped while its worktree was being
   * prepared). Ends its stale rows, expires its entries and puts it back to ready, so the scheduler starts it
   * through the normal start path. No Claude work is lost: there was none.
   */
  requeueAfterCrash(taskId: string): Task {
    const run = this.runs.get(taskId);
    if (run && run.phase !== 'ended') throw new Error(`Task ${taskId} is already running`);
    this.endLiveRows(taskId, 'ended');
    this.deps.inbox.expireForTask(taskId);
    const t = tasks.requeue(this.db, taskId);
    this.emit('state', t);
    return t;
  }

  private settleResume(run: Run, ok: boolean): void {
    if (!run.resumeConfirm) return;
    const c = run.resumeConfirm;
    run.resumeConfirm = null;
    run.resumeId = null;
    c.resolve(ok);
  }

  /** A resume that never confirmed its session: reason 'unrecoverable', the detail in a 'resume-failed' event. */
  private failUnrecoverable(run: Run, detail: string): Promise<void> {
    if (run.detached) return Promise.resolve();
    this.safe('resume-failed event', () => events.append(this.db, {
      missionId: run.missionId, taskId: run.taskId, type: 'resume-failed', data: { detail },
    }));
    return this.fail(run, UNRECOVERABLE);
  }

  /** Sends a user message to the task's live session. Its turn never triggers a handoff reminder. */
  message(taskId: string, text: string): void {
    const run = this.runs.get(taskId);
    if (!run || run.phase !== 'running' || !run.session) throw new SessionClosed(`Task ${taskId} has no live session`);
    run.session.send(text);
    run.turns.push('user');
  }

  private sendOwn(run: Run, text: string): void {
    run.session!.send(text);
    run.turns.push('maestro');
  }

  /**
   * Spec §8.3: interrupt, close, kill; task `cancelled`; open inbox entries expire. Idempotent.
   * Waits for an in-progress start, finish or fail first. Works without a run too (e.g. after a restart).
   */
  stop(taskId: string): Promise<void> {
    let run = this.runs.get(taskId);
    if (run?.phase === 'ended') {
      // That run is over (and maybe already stopped). If the task lives on (e.g. it was retried), stop it afresh.
      const task = tasks.get(this.db, taskId);
      if (task && !TERMINAL.includes(task.state)) run = this.newRun(task);
    }
    if (run?.stopPromise) return run.stopPromise;
    if (!run) {
      const task = tasks.get(this.db, taskId);
      if (!task) return Promise.reject(new Error(`Task not found: ${taskId}`));
      run = this.newRun(task);
    }
    run.stopRequested = true;
    const r = run;
    run.stopPromise = this.runStop(r).catch(e => this.warn(`stop ${taskId}: ${(e as Error)?.message ?? e}`));
    return run.stopPromise;
  }

  /**
   * App shutdown: kills the task's live process (tree) and ends its session row, with no other change. The task
   * keeps its state and its inbox entries stay open, so recovery can resume it. No 'finished' is emitted.
   * Waits for an in-progress start, finish, fail or stop first. Idempotent.
   */
  async detach(taskId: string): Promise<void> {
    const run = this.runs.get(taskId);
    if (!run) return;
    run.stopRequested = true; // a start still preparing its worktree spawns nothing
    run.detached = true; // a completion still waiting for its process to exit ends here (no merge, no transition)
    await run.ready;
    if (run.stopPromise) { await run.stopPromise; return; }
    if (run.finishing && run.session && run.session.status !== 'exited') {
      try { await run.session.kill(); } catch (e) { this.warn(`detach kill: ${(e as Error).message}`); }
    }
    if (run.finishing) await run.finishing;
    if (run.failing) await run.failing;
    if (run.phase === 'ended') return;
    run.phase = 'ended';
    run.finished = true;
    this.settleResume(run, false);
    const s = run.session;
    if (s && s.status !== 'exited') {
      try { await s.kill(); } catch (e) { this.warn(`detach kill: ${(e as Error).message}`); }
    }
    this.safe('end session row', () => this.endSessionRow(run, 'ended'));
  }

  /** detach() for every run of this runner. */
  async detachAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map(id => this.detach(id)));
  }

  private async runStop(run: Run): Promise<void> {
    await run.ready;
    if (run.finishing) await run.finishing;
    if (run.failing) await run.failing;
    if (run.phase === 'ended') return;
    run.phase = 'stopping';
    let cancelled = false;
    try {
      if (run.session) {
        try { await run.session.stop(this.deps.stopTimeoutMs ?? 5000); }
        catch (e) { this.warn(`session stop: ${(e as Error).message}`); }
      }
      this.safe('end session row', () => this.endSessionRow(run, 'ended'));
      this.safe('end live session rows', () => this.endLiveRows(run.taskId, 'ended'));
      this.safe('expire inbox', () => this.deps.inbox.expireForTask(run.taskId));
      const t = tasks.get(this.db, run.taskId);
      if (t && !TERMINAL.includes(t.state)) {
        cancelled = true;
        this.safe('cancel', () => this.transition(run.taskId, 'cancel'));
      }
    } finally {
      run.phase = 'ended';
      this.settleResume(run, false);
      if (cancelled) this.finish(run, { taskId: run.taskId, outcome: 'cancelled' });
    }
  }

  // ---- worktree ------------------------------------------------------------

  /** Reuses a registered worktree; moves a stray folder aside; re-adds an existing branch (retry); else cuts a new branch. */
  private async ensureWorktree(task: Task, branch: string): Promise<string> {
    const root = this.deps.projectRoot;
    const dir = worktreeDirFor(root, task.missionId, task.taskKey);
    if (existsSync(dir)) {
      if (await isRegisteredWorktree(root, dir)) return dir;
      // Never delete: a path-normalisation mismatch could make real agent work look unregistered.
      const aside = `${dir}.stale-${Date.now()}`;
      renameSync(dir, aside);
      this.warn(`${dir} is not a registered worktree; moved it to ${aside}`);
    }
    await pruneWorktrees(root);
    if (await branchExists(root, branch)) await addExistingBranchWorktree(root, branch, dir);
    else await createTaskWorktree(root, this.deps.missionBranch, branch, dir);
    return dir;
  }

  // ---- session plumbing ----------------------------------------------------

  private spawn(run: Run, role: RoleConfig, cwd: string, resumeSessionId?: string): void {
    mkdirSync(this.deps.logDir, { recursive: true });
    const task = this.task(run.taskId);
    const tag = `${task.taskKey.replace(/[^A-Za-z0-9._-]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const systemPromptFile = join(this.deps.logDir, `${tag}.system.md`);
    writeFileSync(systemPromptFile, role.body + '\n');
    const logPath = join(this.deps.logDir, `${tag}.log`);
    run.logPath = logPath;
    const args = buildTaskArgs(role, systemPromptFile, this.deps.bridgeAskConfig(run.taskId), resumeSessionId);
    const command = this.deps.command ?? (this.deps.exe ? { exe: this.deps.exe, prefixArgs: [] } : undefined);
    const session = ClaudeSession.start({ args, cwd, logPath, env: this.deps.env, command });
    run.session = session;
    session.on('event', (ev: StreamEvent) => this.onEvent(run, ev));
    session.on('error', (e: Error) => { run.lastError = e.message; });
    session.on('exit', (info: { code: number | null }) => this.onExit(run, info.code));
    run.phase = 'running';
    const row = sessions.start(this.db, {
      missionId: run.missionId, taskId: run.taskId, role: role.name, claudeSessionId: resumeSessionId ?? null,
      pid: session.pid, logPath,
    });
    run.rowId = row.id;
    this.registry.set(row.id, session);
  }

  private endSessionRow(run: Run, state: 'ended' | 'failed'): void {
    if (run.rowId) this.registry.delete(run.rowId);
    if (run.rowEnded || !run.rowId) return;
    run.rowEnded = true;
    sessions.end(this.db, run.rowId, state);
  }

  /** Ends every live session row of a task (rows of processes this runner does not hold, e.g. before a restart). */
  private endLiveRows(taskId: string, state: 'ended' | 'failed'): void {
    for (const s of sessions.listLive(this.db)) {
      if (s.taskId !== taskId) continue;
      this.registry.delete(s.id);
      sessions.end(this.db, s.id, state);
    }
  }

  /** fail() for fire-and-forget call sites. */
  private failLater(run: Run, reason: string): void {
    this.fail(run, reason).catch(e => this.warn(`fail: ${(e as Error)?.message ?? e}`));
  }

  private onEvent(run: Run, ev: StreamEvent): void {
    try {
      this.handleEvent(run, ev);
    } catch (e) {
      if (run.phase === 'running') this.failLater(run, `internal: ${(e as Error).message}`);
      else this.warn(`event ${ev.kind}: ${(e as Error).message}`);
    }
  }

  private handleEvent(run: Run, ev: StreamEvent): void {
    const now = Date.now();
    if (run.phase === 'running' && now - run.lastActivityAt >= (this.deps.activityEveryMs ?? ACTIVITY_EVERY_MS)) {
      run.lastActivityAt = now;
      events.append(this.db, { missionId: run.missionId, taskId: run.taskId, type: 'activity', data: { kind: ev.kind } });
    }
    switch (ev.kind) {
      case 'init': {
        if (run.resumeId && ev.sessionId === run.resumeId) this.settleResume(run, true);
        if (ev.sessionId) {
          tasks.setRuntime(this.db, run.taskId, { sessionId: ev.sessionId });
          if (run.rowId) sessions.setClaudeSessionId(this.db, run.rowId, ev.sessionId);
        }
        const bad = run.role ? unsafeTools(run.role, ev.tools) : [];
        if (bad.length > 0 && run.phase === 'running') this.failLater(run, `unsafe-tools: ${bad.join(',')}`);
        return;
      }
      case 'assistant':
        if (ev.parentToolUseId === null && ev.text.trim()) run.lastAssistantText = ev.text;
        return;
      case 'permission-request':
        if (run.phase === 'running' && run.rowId) this.deps.inbox.onPermissionRequest(run.missionId, run.taskId, run.rowId, ev);
        return;
      case 'permission-cancel':
        this.deps.inbox.onPermissionCancel(ev.requestId);
        return;
      case 'result': {
        this.settleResume(run, true);
        tasks.addUsage(this.db, run.taskId, ev.usage);
        if (run.phase !== 'running') return; // e.g. the interrupt result of our own stop
        // One result can answer every queued message (the CLI folds queued input into the running turn), so the
        // queue is cleared. Any user message in it makes this the user's turn: only Maestro's own turns remind or fail.
        const origin: TurnOrigin = run.turns.includes('user') ? 'user' : run.turns.length > 0 ? 'maestro' : 'user';
        run.turns = [];
        if (!ev.ok) { this.failLater(run, ev.subtype || 'error'); return; }
        const handoff = lastHandoff(ev.text ?? '') ?? lastHandoff(run.lastAssistantText);
        if (handoff !== null) { this.complete(run, handoff); return; }
        if (origin !== 'maestro') return; // a reply to the user's message: no reminder, no failure
        if (!run.reminded) {
          run.reminded = true;
          try { this.sendOwn(run, HANDOFF_REMINDER); }
          catch (e) { this.failLater(run, `no-handoff (${(e as Error).message})`); }
          return;
        }
        this.failLater(run, 'no-handoff');
        return;
      }
      default:
        return;
    }
  }

  private onExit(run: Run, code: number | null): void {
    if (run.phase !== 'running') return;
    const tail = this.logTail(run);
    let reason = `crashed (exit code ${code ?? 'none'}${run.lastError ? `, ${run.lastError}` : ''})`;
    if (tail) reason += `\n${tail}`;
    if (run.resumeId) { // the --resume process ended before it confirmed the session
      this.failUnrecoverable(run, reason).catch(e => this.warn(`fail: ${(e as Error)?.message ?? e}`));
      return;
    }
    this.failLater(run, reason);
  }

  private logTail(run: Run): string {
    if (!run.logPath) return '';
    let text: string;
    try { text = readFileSync(run.logPath, 'utf8'); } catch { return ''; }
    let tail = text.replace(/\r\n/g, '\n').split('\n').filter(l => l !== '').slice(-CRASH_LOG_LINES).join('\n');
    if (tail.length > CRASH_LOG_MAX) tail = '…' + tail.slice(tail.length - CRASH_LOG_MAX + 1);
    return tail;
  }

  private inboxChanged(e: InboxChanged): void {
    if (!e.taskId) return;
    const taskId = e.taskId;
    const run = this.runs.get(taskId);
    if (!run || run.phase !== 'running') return;
    this.safe('needs-you', () => {
      const open = inboxRepo.openCountForTask(this.db, taskId);
      const t = tasks.get(this.db, taskId);
      if (!t) return;
      if (open > 0 && t.state === 'running') this.transition(taskId, 'needs_user');
      else if (open === 0 && t.state === 'needs_you') this.transition(taskId, 'answered');
    });
  }

  // ---- endings -------------------------------------------------------------

  /** Emits 'finished' at most once per run; a throwing listener is logged, never propagated. */
  private finish(run: Run, f: TaskFinished): void {
    this.settleResume(run, false);
    if (run.finished) return;
    run.finished = true;
    try { this.emit('finished', f); } catch (e) { this.warn(`finished listener: ${(e as Error)?.message ?? e}`); }
  }

  /** Fails the run once. The work runs on a later microtask, so `run.failing` is set before any listener fires. */
  private fail(run: Run, reason: string): Promise<void> {
    if (run.failing) return run.failing;
    if (run.detached) return Promise.resolve(); // shutdown: the task keeps its state for recovery
    if (run.phase !== 'starting' && run.phase !== 'running') return Promise.resolve();
    run.phase = 'failing';
    run.failing = Promise.resolve()
      .then(async () => {
        try { await this.failSteps(run, reason); }
        finally {
          run.phase = 'ended';
          this.finish(run, { taskId: run.taskId, outcome: 'failed', reason });
        }
      })
      .catch(e => this.warn(`fail: ${(e as Error)?.message ?? e}`));
    return run.failing;
  }

  /** Each step is guarded, so this never throws. */
  private async failSteps(run: Run, reason: string): Promise<void> {
    this.safe('failure reason', () => tasks.setRuntime(this.db, run.taskId, { failureReason: reason }));
    this.safe('expire inbox', () => this.deps.inbox.expireForTask(run.taskId));
    this.safe('fail transition', () => {
      const t = this.task(run.taskId);
      if (t.state === 'running' || t.state === 'needs_you') this.transition(run.taskId, 'fail');
    });
    if (run.session) {
      try { await run.session.stop(this.deps.stopTimeoutMs ?? 5000); }
      catch (e) { this.warn(`session stop: ${(e as Error).message}`); }
    }
    this.safe('end session row', () => this.endSessionRow(run, 'failed'));
  }

  /** Spec §8.1: handoff found. Close stdin, wait for exit, commit leftovers, merge --no-ff into the mission branch. */
  private complete(run: Run, handoff: string): void {
    run.phase = 'finishing';
    run.finishing = Promise.resolve()
      .then(async () => {
        let f: TaskFinished;
        try {
          const reason = await this.completeSteps(run, handoff);
          if (reason === DETACHED) {
            // Shutdown: the task stays as it is (its handoff is stored) for recovery; no 'finished'.
            this.safe('end session row', () => this.endSessionRow(run, 'ended'));
            run.phase = 'ended';
            run.finished = true;
            this.settleResume(run, false);
            return;
          }
          f = reason === null ? { taskId: run.taskId, outcome: 'done' } : { taskId: run.taskId, outcome: 'failed', reason };
        } catch (e) {
          // A throw after the task reached done (e.g. a 'state' listener) must not turn it into a failure.
          f = tasks.get(this.db, run.taskId)?.state === 'done'
            ? { taskId: run.taskId, outcome: 'done' }
            : { taskId: run.taskId, outcome: 'failed', reason: `internal: ${(e as Error)?.message ?? e}` };
          if (f.outcome === 'done') this.warn(`after completion: ${(e as Error)?.message ?? e}`);
        }
        try { if (f.outcome === 'failed') await this.failSteps(run, f.reason!); }
        finally {
          run.phase = 'ended';
          this.finish(run, f);
        }
      })
      .catch(e => this.warn(`complete: ${(e as Error)?.message ?? e}`));
  }

  /** Returns null when merged and done, DETACHED when detach() interrupted it before the merge, or a failure reason. */
  private async completeSteps(run: Run, handoff: string): Promise<string | null> {
    tasks.setRuntime(this.db, run.taskId, { handoffMd: handoff });
    const session = run.session!;
    const exited = new Promise<boolean>(res => {
      if (session.status === 'exited') { res(true); return; }
      const timer = setTimeout(() => res(false), CLOSE_WAIT_MS);
      session.once('exit', () => { clearTimeout(timer); res(true); });
    });
    let closed = false;
    try { session.close(); closed = true; } catch { /* busy (a user message raced in): stop instead */ }
    if (!closed || !(await exited)) {
      try { await session.stop(this.deps.stopTimeoutMs ?? 5000); }
      catch (e) { this.warn(`session stop: ${(e as Error).message}`); }
    }
    if (run.detached) return DETACHED;
    this.endSessionRow(run, 'ended');

    const task = this.task(run.taskId);
    try { await this.commitLeftovers(task); }
    catch (e) { return `commit: ${(e as Error).message}`; }
    let merged: Awaited<ReturnType<typeof mergeTaskBranch>>;
    try {
      merged = await mergeTaskBranch(this.deps.projectRoot, this.deps.missionBranch, task.branch!,
        `Merge ${task.taskKey}: ${task.title}`, task.missionId);
    } catch (e) { return `merge: ${(e as Error).message}`; }
    if (!merged.ok) return `conflict: ${merged.files.join(', ')}`;
    events.append(this.db, { missionId: task.missionId, taskId: task.id, type: 'merged', data: { commit: merged.commit, branch: task.branch } });
    // Leftover entries expire; a task in needs_you returns to running so that `complete` is legal.
    this.deps.inbox.expireForTask(run.taskId);
    if (this.task(run.taskId).state === 'needs_you') this.transition(run.taskId, 'answered');
    this.transition(run.taskId, 'complete');
    return null;
  }

  /** Commits anything the agent left uncommitted in its worktree, so the merge carries all of its work. */
  private async commitLeftovers(task: Task): Promise<void> {
    const cwd = task.worktreePath!;
    const git = (args: string[]) => execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await git(['status', '--porcelain']);
    if (stdout.trim() === '') return;
    await git(['add', '-A']);
    await git(['commit', '-m', `maestro: uncommitted changes from ${task.taskKey}`]);
  }
}
