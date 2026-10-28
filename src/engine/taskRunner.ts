// Runs one task's whole lifecycle (spec §8.1, §8.3, §9): worktree, claude session with the role's settings,
// permissions to the inbox, completion via the `## Handoff` section, merge into the mission branch, stop and recovery.
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../store/db.js';
import { events, inbox as inboxRepo, sessions, tasks, type Task } from '../store/repos.js';
import type { TaskEvent } from '../core/state/taskMachine.js';
import { AGENT_ROLES, type AgentRole } from '../core/types.js';
import { ClaudeSession, SessionClosed } from '../claude/session.js';
import { lastHandoff, type StreamEvent } from '../claude/protocol.js';
import { createTaskWorktree, mergeTaskBranch, worktreeDirFor } from '../git/worktrees.js';
import type { InboxChanged, InboxService, SessionRegistry } from './inbox.js';

const execFileP = promisify(execFile);

export const HANDOFF_REMINDER = 'Finish with a ## Handoff section.';
export const RESUME_MESSAGE =
  'Maestro restarted while you were working. Continue the task where you left off and finish with a ## Handoff section.';
/** Tools of Maestro's own bridge MCP server (named `maestro` in the bridge config). Any other mcp__* tool is unsafe. */
export const BRIDGE_TOOL_PREFIX = 'mcp__maestro__';
const READ_ONLY_FORBIDDEN = ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit'];
const CLOSE_WAIT_MS = 10_000;
const CRASH_LOG_LINES = 50;
const CRASH_LOG_MAX = 4096;

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

/** Tools from `init` that the session must not have: foreign MCP tools always, write/shell tools for read-only roles. */
export function unsafeTools(role: RoleConfig, tools: string[]): string[] {
  return tools.filter(t =>
    (t.startsWith('mcp__') && !t.startsWith(BRIDGE_TOOL_PREFIX)) || (role.tools !== undefined && READ_ONLY_FORBIDDEN.includes(t)));
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

type Phase = 'starting' | 'running' | 'finishing' | 'stopping' | 'ended';

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
  lastAssistantText: string;
  lastError: string | null;
  finished: boolean;
  /** Settles when start/resume finished spawning (or failed). */
  ready: Promise<void>;
  stopPromise: Promise<void> | null;
  /** Settles when finishing (close + merge) is over. */
  finishing: Promise<void> | null;
}

export class TaskRunner extends EventEmitter {
  readonly registry: LiveSessionRegistry;
  private runs = new Map<string, Run>();
  private readonly onInboxChanged = (e: InboxChanged): void => this.inboxChanged(e);

  constructor(private deps: TaskRunnerDeps) {
    super();
    this.registry = deps.registry ?? new LiveSessionRegistry();
    deps.inbox.on('changed', this.onInboxChanged);
  }

  dispose(): void { this.deps.inbox.off('changed', this.onInboxChanged); }

  private get db(): Db { return this.deps.db; }

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
      rowEnded: false, logPath: null, reminded: false, lastAssistantText: '', lastError: null, finished: false,
      ready: Promise.resolve(), stopPromise: null, finishing: null,
    };
    this.runs.set(task.id, run);
    return run;
  }

  async start(taskId: string, upstreamHandoffs: { key: string; handoff: string }[]): Promise<void> {
    const task = this.task(taskId);
    if (task.state !== 'ready') throw new Error(`Task ${task.taskKey} is ${task.state}, expected ready`);
    const run = this.newRun(task);
    let release!: () => void;
    run.ready = new Promise<void>(r => { release = r; });
    try {
      this.transition(taskId, 'start');
      let role: RoleConfig;
      try { role = loadRole(task.agent as AgentRole, this.deps.rolesDir); }
      catch (e) { await this.fail(run, `unknown-agent: ${(e as Error).message}`); return; }
      run.role = role;
      const slug = this.deps.missionBranch.slice(this.deps.missionBranch.lastIndexOf('/') + 1);
      const branch = `maestro/${slug}/${task.taskKey}`;
      if (branch.startsWith(`${this.deps.missionBranch}/`)) {
        // git keeps refs as files: refs/heads/a/b cannot exist next to refs/heads/a/b/T1.
        await this.fail(run, `worktree: task branch ${branch} clashes with mission branch ${this.deps.missionBranch}; `
          + 'the mission branch must not be named maestro/<slug>');
        return;
      }
      let dir: string;
      try {
        dir = worktreeDirFor(this.deps.projectRoot, task.missionId, task.taskKey);
        if (!existsSync(dir)) await createTaskWorktree(this.deps.projectRoot, this.deps.missionBranch, branch, dir);
      } catch (e) { await this.fail(run, `worktree: ${(e as Error).message}`); return; }
      tasks.setRuntime(this.db, taskId, { worktreePath: dir, branch });
      if (run.phase !== 'starting') return; // stopped meanwhile
      this.spawn(run, role, dir);
      run.session!.send(buildTaskPrompt(task, upstreamHandoffs));
    } catch (e) {
      if (run.phase === 'starting' || run.phase === 'running') await this.fail(run, `start: ${(e as Error).message}`);
      else throw e;
    } finally {
      release();
    }
  }

  /** Recovery only: the app restarted while the task was running. Starts a new process with `--resume <sessionId>`. */
  async resumeAfterCrash(taskId: string): Promise<void> {
    let task = this.task(taskId);
    if (task.state !== 'running' && task.state !== 'needs_you') throw new Error(`Task ${task.taskKey} is ${task.state}, not running`);
    const run = this.newRun(task);
    let release!: () => void;
    run.ready = new Promise<void>(r => { release = r; });
    try {
      // The old process is gone: its permission requests can never be answered.
      for (const s of sessions.listLive(this.db)) if (s.taskId === taskId) sessions.end(this.db, s.id, 'failed');
      this.deps.inbox.expireForTask(taskId);
      task = this.task(taskId);
      if (task.state === 'needs_you') task = this.transition(taskId, 'answered');
      if (!task.sessionId || !task.worktreePath || !existsSync(task.worktreePath)) {
        await this.fail(run, 'crashed: no session or worktree to resume');
        return;
      }
      let role: RoleConfig;
      try { role = loadRole(task.agent as AgentRole, this.deps.rolesDir); }
      catch (e) { await this.fail(run, `unknown-agent: ${(e as Error).message}`); return; }
      run.role = role;
      this.spawn(run, role, task.worktreePath, task.sessionId);
      run.session!.send(RESUME_MESSAGE);
    } catch (e) {
      if (run.phase === 'starting' || run.phase === 'running') await this.fail(run, `resume: ${(e as Error).message}`);
      else throw e;
    } finally {
      release();
    }
  }

  /** Sends a user message to the task's live session. */
  message(taskId: string, text: string): void {
    const run = this.runs.get(taskId);
    if (!run || run.phase !== 'running' || !run.session) throw new SessionClosed(`Task ${taskId} has no live session`);
    run.session.send(text);
  }

  /** Spec §8.3: interrupt, close, kill; task `cancelled`; open inbox entries expire. Idempotent. */
  stop(taskId: string): Promise<void> {
    const run = this.runs.get(taskId);
    if (run?.stopPromise) return run.stopPromise;
    const p = this.runStop(taskId, run);
    if (run) run.stopPromise = p;
    return p;
  }

  private async runStop(taskId: string, run: Run | undefined): Promise<void> {
    if (run) {
      await run.ready;
      if (run.finishing) { await run.finishing; return; }
      if (run.phase === 'ended') return;
      run.phase = 'stopping';
      if (run.session) {
        try { await run.session.stop(this.deps.stopTimeoutMs ?? 5000); } catch { /* best effort */ }
      }
      this.endSessionRow(run, 'ended');
    }
    this.deps.inbox.expireForTask(taskId);
    const t = tasks.get(this.db, taskId);
    if (t && !['done', 'failed', 'cancelled'].includes(t.state)) this.transition(taskId, 'cancel');
    if (run) {
      run.phase = 'ended';
      this.finish(run, { taskId, outcome: 'cancelled' });
    }
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
    const row = sessions.start(this.db, {
      missionId: run.missionId, taskId: run.taskId, role: role.name, claudeSessionId: resumeSessionId ?? null,
      pid: session.pid, logPath,
    });
    run.rowId = row.id;
    this.registry.set(row.id, session);
    session.on('event', (ev: StreamEvent) => this.onEvent(run, ev));
    session.on('error', (e: Error) => { run.lastError = e.message; });
    session.on('exit', (info: { code: number | null }) => this.onExit(run, info.code));
    run.phase = 'running';
  }

  private endSessionRow(run: Run, state: 'ended' | 'failed'): void {
    if (run.rowId) this.registry.delete(run.rowId);
    if (run.rowEnded || !run.rowId) return;
    run.rowEnded = true;
    sessions.end(this.db, run.rowId, state);
  }

  private onEvent(run: Run, ev: StreamEvent): void {
    try {
      this.handleEvent(run, ev);
    } catch (e) {
      if (run.phase === 'running') void this.fail(run, `internal: ${(e as Error).message}`);
    }
  }

  private handleEvent(run: Run, ev: StreamEvent): void {
    switch (ev.kind) {
      case 'init': {
        if (ev.sessionId) {
          tasks.setRuntime(this.db, run.taskId, { sessionId: ev.sessionId });
          if (run.rowId) sessions.setClaudeSessionId(this.db, run.rowId, ev.sessionId);
        }
        const bad = run.role ? unsafeTools(run.role, ev.tools) : [];
        if (bad.length > 0 && run.phase === 'running') void this.fail(run, `unsafe-tools: ${bad.join(',')}`);
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
        tasks.addUsage(this.db, run.taskId, ev.usage);
        if (run.phase !== 'running') return; // e.g. the interrupt result of our own stop
        if (!ev.ok) { void this.fail(run, ev.subtype || 'error'); return; }
        const handoff = lastHandoff(ev.text ?? '') ?? lastHandoff(run.lastAssistantText);
        if (handoff !== null) {
          run.finishing = this.complete(run, handoff).catch(e => this.fail(run, `internal: ${(e as Error).message}`));
          return;
        }
        if (!run.reminded) {
          run.reminded = true;
          try { run.session?.send(HANDOFF_REMINDER); }
          catch (e) { void this.fail(run, `no-handoff (${(e as Error).message})`); }
          return;
        }
        void this.fail(run, 'no-handoff');
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
    void this.fail(run, reason);
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
    const run = this.runs.get(e.taskId);
    if (!run || run.phase !== 'running') return;
    const open = inboxRepo.openCountForTask(this.db, e.taskId);
    const t = tasks.get(this.db, e.taskId);
    if (!t) return;
    if (open > 0 && t.state === 'running') this.transition(e.taskId, 'needs_user');
    else if (open === 0 && t.state === 'needs_you') this.transition(e.taskId, 'answered');
  }

  // ---- endings -------------------------------------------------------------

  private finish(run: Run, f: TaskFinished): void {
    if (run.finished) return;
    run.finished = true;
    this.emit('finished', f);
  }

  /** Expires leftover entries; a task in needs_you returns to running so that `complete` is legal. */
  private settleInbox(run: Run): void {
    this.deps.inbox.expireForTask(run.taskId);
    if (this.task(run.taskId).state === 'needs_you') this.transition(run.taskId, 'answered');
  }

  private async fail(run: Run, reason: string): Promise<void> {
    if (run.phase === 'ended' || run.phase === 'stopping') return;
    run.phase = 'ended';
    tasks.setRuntime(this.db, run.taskId, { failureReason: reason });
    this.deps.inbox.expireForTask(run.taskId);
    const t = this.task(run.taskId);
    if (t.state === 'running' || t.state === 'needs_you') this.transition(run.taskId, 'fail');
    if (run.session) {
      try { await run.session.stop(this.deps.stopTimeoutMs ?? 5000); } catch { /* best effort */ }
    }
    this.endSessionRow(run, 'failed');
    this.finish(run, { taskId: run.taskId, outcome: 'failed', reason });
  }

  /** Spec §8.1: handoff found. Close stdin, wait for exit, commit leftovers, merge --no-ff into the mission branch. */
  private async complete(run: Run, handoff: string): Promise<void> {
    run.phase = 'finishing';
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
      try { await session.stop(this.deps.stopTimeoutMs ?? 5000); } catch { /* best effort */ }
    }
    this.endSessionRow(run, 'ended');

    const task = this.task(run.taskId);
    const failAfterClose = (reason: string): Promise<void> => this.fail(run, reason);
    try {
      await this.commitLeftovers(task);
    } catch (e) { await failAfterClose(`commit: ${(e as Error).message}`); return; }
    let merged: Awaited<ReturnType<typeof mergeTaskBranch>>;
    try {
      merged = await mergeTaskBranch(this.deps.projectRoot, this.deps.missionBranch, task.branch!,
        `Merge ${task.taskKey}: ${task.title}`, task.missionId);
    } catch (e) { await failAfterClose(`merge: ${(e as Error).message}`); return; }
    if (!merged.ok) { await failAfterClose(`conflict: ${merged.files.join(', ')}`); return; }
    events.append(this.db, { missionId: task.missionId, taskId: task.id, type: 'merged', data: { commit: merged.commit, branch: task.branch } });
    this.settleInbox(run);
    this.transition(run.taskId, 'complete');
    run.phase = 'ended';
    this.finish(run, { taskId: run.taskId, outcome: 'done' });
  }

  /** Commits anything the agent left uncommitted in its worktree, so the merge carries all of its work. */
  private async commitLeftovers(task: Task): Promise<void> {
    const cwd = task.worktreePath!;
    const git = (args: string[]) => execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await git(['status', '--porcelain']);
    if (stdout.trim() === '') return;
    await git(['add', '-A']);
    await git(['commit', '-m', `chore(${task.taskKey}): uncommitted changes left by the agent`]);
  }
}

