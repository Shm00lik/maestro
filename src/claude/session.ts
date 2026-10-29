// One long-lived claude.exe stream-json process. Stopping is only via stdin interrupt / stdin end / killTree
// (never child.kill() or SIGINT: they orphan grandchildren on Windows).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveClaudeCommand } from './exe.js';
import { ASYNC_TIMEOUT_MS, killPidAsync, killTreeAsync, listTreePidsAsync } from './processTree.js';
import {
  encodeInterrupt, encodePermissionAllow, encodePermissionDeny, encodeUserMessage, parseEvent, type StreamEvent,
} from './protocol.js';

const KILL_WAIT_MS = 5000;

export const BASE_ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--replay-user-messages', '--permission-prompt-tool', 'stdio',
];

export interface SessionOptions {
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  logPath: string;
  command?: { exe: string; prefixArgs: string[] };
  /** Test hooks. */
  listTree?: (pid: number) => Promise<number[]>;
  killTree?: (pid: number) => Promise<{ ok: boolean; output: string }>;
  /** Kills one pid (no /T); used for snapshot survivors. */
  killPid?: (pid: number) => Promise<{ ok: boolean; output: string }>;
  /** Upper bound on the stop snapshot, measured from the start of stop(). */
  snapshotWaitMs?: number;
}
export type SessionStatus = 'starting' | 'busy' | 'idle' | 'exited';
export interface ExitInfo { code: number | null; killed: boolean }

export class SessionClosed extends Error {
  constructor(message = 'Claude session is closed') { super(message); this.name = 'SessionClosed'; }
}

export class ClaudeSession extends EventEmitter {
  readonly pid: number;
  status: SessionStatus = 'starting';
  sessionId: string | null = null;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logPath: string;
  private outBuf = '';
  private errBuf = '';
  private stdinEnded = false;
  private errorEmitted = false;
  private weKilled = false;
  private exitCode: number | null = null;
  private finalized = false;
  /** The OS process really exited (exit/close seen), unlike a finalize forced after a kill that got no exit. */
  private processExited = false;
  private stopping = false;
  private readonly listTreeFn: (pid: number) => Promise<number[]>;
  private readonly killTreeFn: (pid: number) => Promise<{ ok: boolean; output: string }>;
  private readonly killPidFn: (pid: number) => Promise<{ ok: boolean; output: string }>;
  private readonly snapshotWaitMs: number;
  private killPromise: Promise<void> | null = null;
  private stopPromise: Promise<'exited' | 'killed'> | null = null;

  static start(opts: SessionOptions): ClaudeSession { return new ClaudeSession(opts); }

  /**
   * True once the OS reported the process exit. False while it runs, and also when kill() gave up waiting and
   * finalized the session anyway (status 'exited', but the process may still be alive).
   */
  get exitConfirmed(): boolean { return this.processExited || this.pid <= 0; }

  private constructor(opts: SessionOptions) {
    super();
    this.logPath = opts.logPath;
    this.listTreeFn = opts.listTree ?? listTreePidsAsync;
    this.killTreeFn = opts.killTree ?? killTreeAsync;
    this.killPidFn = opts.killPid ?? killPidAsync;
    this.snapshotWaitMs = opts.snapshotWaitMs ?? ASYNC_TIMEOUT_MS;
    mkdirSync(dirname(opts.logPath), { recursive: true });
    const command = opts.command ?? resolveClaudeCommand();
    this.child = spawn(command.exe, [...command.prefixArgs, ...BASE_ARGS, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, MCP_TOOL_TIMEOUT: '86400000', ...opts.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid ?? -1;

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d: string) => { if (this.finalized) return; this.outBuf = this.lines(this.outBuf + d, false); });
    this.child.stderr.on('data', (d: string) => { if (this.finalized) return; this.errBuf = this.lines(this.errBuf + d, true); });
    this.child.stdin.on('error', (e: Error) => this.emitErrorOnce(e));
    this.child.on('error', (e: Error) => {
      this.emitErrorOnce(e);
      if (this.child.pid === undefined) { this.status = 'exited'; this.finalize(null); }
    });
    this.child.on('exit', (code: number | null) => {
      this.processExited = true;
      this.status = 'exited';
      this.exitCode = code;
      setTimeout(() => this.finalize(code), 500).unref(); // fallback if inherited pipes keep 'close' from firing
    });
    this.child.on('close', (code: number | null) => { this.processExited = true; this.finalize(code ?? this.exitCode); });
  }

  private emitErrorOnce(e: Error): void {
    if (this.errorEmitted) return;
    this.errorEmitted = true;
    // An 'error' with no listener would crash the host process: log it instead.
    if (this.listenerCount('error') > 0) this.emit('error', e);
    else this.log(`[session error] ${e.message}`);
  }

  private log(text: string): void {
    try { appendFileSync(this.logPath, text + '\n'); } catch { /* logging must not break the session */ }
  }

  /** Consume complete lines from buf; returns the remaining partial line. flush=true consumes the partial too. */
  private lines(buf: string, stderr: boolean, flush = false): string {
    let rest = buf;
    for (;;) {
      const i = rest.indexOf('\n');
      let line: string;
      if (i >= 0) { line = rest.slice(0, i); rest = rest.slice(i + 1); }
      else if (flush && rest !== '') { line = rest; rest = ''; }
      else break;
      line = line.replace(/\r$/, '');
      if (line === '') continue;
      if (stderr) { this.log(`[stderr] ${line}`); continue; }
      this.log(line);
      const ev = parseEvent(line);
      if (ev) this.handle(ev);
    }
    return rest;
  }

  private handle(ev: StreamEvent): void {
    if (ev.kind === 'init') {
      this.sessionId = ev.sessionId;
      if (this.status === 'starting') this.status = 'idle';
    } else if (ev.kind === 'result') {
      if (this.status !== 'exited') this.status = 'idle';
    }
    this.emit('event', ev);
  }

  private finalize(code: number | null): void {
    if (this.finalized) return;
    this.finalized = true;
    this.outBuf = this.lines(this.outBuf, false, true);
    this.errBuf = this.lines(this.errBuf, true, true);
    this.status = 'exited';
    const info: ExitInfo = { code, killed: this.weKilled };
    this.emit('exit', info);
  }

  private write(data: string, internal = false): void {
    if ((this.stopping && !internal) || this.status === 'exited' || this.stdinEnded || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new SessionClosed();
    }
    this.child.stdin.write(data);
  }

  send(text: string): void {
    this.write(encodeUserMessage(text));
    this.status = 'busy';
  }

  answerPermission(requestId: string, decision: { allow: true; input: unknown } | { allow: false; message: string }): void {
    this.write(decision.allow ? encodePermissionAllow(requestId, decision.input) : encodePermissionDeny(requestId, decision.message));
  }

  /**
   * Stop per spec 8.3: snapshot the tree (started, not awaited, so it never delays the interrupt);
   * if busy write ONE interrupt and wait up to timeoutMs for a result (skipped if the write fails);
   * wait for the snapshot to settle (bounded by snapshotWaitMs from the start), so it still holds the
   * root and its tool children; end stdin and wait up to timeoutMs for exit; else killTree; then kill
   * each snapshot PID still alive (by pid, no /T).
   * Concurrent calls share one run. After this starts, send/answerPermission throw SessionClosed.
   * Resolves 'killed' exactly when the exit info says killed.
   */
  stop(timeoutMs = 5000): Promise<'exited' | 'killed'> {
    if (this.stopPromise) return this.stopPromise;
    if (this.status === 'exited' || this.finalized) return Promise.resolve('exited');
    this.stopping = true;
    this.stopPromise = this.runStop(timeoutMs);
    return this.stopPromise;
  }

  /** Descendants of the root (root excluded); [] when listing fails, lacks the root, or exceeds snapshotWaitMs. Never rejects. */
  private snapshotTree(): Promise<number[]> {
    if (this.pid <= 0) return Promise.resolve([]);
    return new Promise<number[]>(resolve => {
      let settled = false;
      const settle = (pids: number[], note?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (note) this.log(`[session] stop: ${note}; skipping snapshot kills`);
        resolve(pids);
      };
      const timer = setTimeout(() => settle([], `tree snapshot timed out after ${this.snapshotWaitMs}ms`), this.snapshotWaitMs);
      let listing: Promise<number[]>;
      try { listing = Promise.resolve(this.listTreeFn(this.pid)); }
      catch (e) { listing = Promise.reject(e); }
      listing.then(
        pids => {
          if (pids.includes(this.pid)) settle(pids.filter(p => p !== this.pid));
          else settle([], 'tree snapshot failed or missing root');
        },
        (e: unknown) => settle([], `tree snapshot threw: ${(e as Error)?.message ?? String(e)}`),
      );
    });
  }

  private async runStop(timeoutMs: number): Promise<'exited' | 'killed'> {
    const hasExited = (): boolean => this.finalized || this.status === 'exited';
    // Resolves true when `exit` is emitted, false on timeout (or `ev` predicate, when given, matched -> true).
    const waitFor = (ms: number, onEvent?: (e: StreamEvent) => boolean): Promise<boolean> => new Promise(resolve => {
      const done = (v: boolean): void => {
        clearTimeout(timer);
        this.off('exit', onExit);
        this.off('event', onEv);
        resolve(v);
      };
      const onExit = (): void => done(true);
      const onEv = (e: StreamEvent): void => { if (onEvent?.(e)) done(true); };
      const timer = setTimeout(() => done(false), ms);
      this.on('exit', onExit);
      if (onEvent) this.on('event', onEv);
      if (this.finalized) done(true);
    });

    // Step 1: start the snapshot now; it is awaited (bounded) only before step 3, never before the interrupt.
    const snapshot = this.snapshotTree();

    // Step 2: one interrupt if mid-turn. A result can only arrive on a later tick, so waiting after the write is safe.
    if (!hasExited() && this.status === 'busy') {
      let wrote = false;
      try { this.write(encodeInterrupt(`maestro-int-${randomUUID()}`), true); wrote = true; }
      catch (e) { this.log(`[session] stop: interrupt write failed (${(e as Error).message}); skipping result wait`); }
      if (wrote) await waitFor(timeoutMs, e => e.kind === 'result');
    }

    // Hold step 3 until the snapshot settles (listed, failed or timed out): ending stdin lets the root exit,
    // and a listing taken after that has no root and would be discarded.
    const survivors = await snapshot;

    // Steps 3-4: end stdin and wait for exit, else kill the tree (bounded).
    if (!hasExited()) {
      if (!this.stdinEnded && !this.child.stdin.destroyed) { this.stdinEnded = true; this.child.stdin.end(); }
      if (!(await waitFor(timeoutMs))) await this.kill();
    }

    // Step 5: kill snapshot PIDs still alive. Each descendant is in the list, so no /T (limits PID-reuse damage).
    for (const pid of survivors) {
      let up = true;
      try { process.kill(pid, 0); } catch { up = false; }
      if (up) { try { await this.killPidFn(pid); } catch { /* never throws */ } }
    }
    return this.weKilled ? 'killed' : 'exited';
  }

  /**
   * Ends stdin. Allowed while starting/idle, a no-op once exited or already ended,
   * and throws when busy (stop() first).
   */
  close(): void {
    if (this.status === 'busy') throw new Error('Cannot close a busy session: stop() it first');
    if (this.status === 'exited' || this.stdinEnded) return;
    this.stdinEnded = true;
    this.child.stdin.end();
  }

  kill(): Promise<void> {
    if (this.killPromise) return this.killPromise;
    this.killPromise = new Promise<void>(resolve => {
      if (this.finalized) { resolve(); return; }
      this.once('exit', () => resolve());
      if (this.status !== 'exited') {
        this.weKilled = true;
        this.stdinEnded = true;
        let r = 'pending';
        if (this.pid > 0) void this.killTreeFn(this.pid).then(x => { r = `ok=${x.ok} ${x.output}`; }, () => { r = 'rejected'; });
        setTimeout(() => {
          if (this.finalized) return;
          this.log(`[session] no exit ${KILL_WAIT_MS}ms after killTree (${r})`);
          this.finalize(null);
        }, KILL_WAIT_MS).unref();
      }
    });
    return this.killPromise;
  }
}
