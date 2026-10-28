// One long-lived claude.exe stream-json process. Stopping is only via stdin interrupt / stdin end / killTree
// (never child.kill() or SIGINT: they orphan grandchildren on Windows).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveClaudeCommand } from './exe.js';
import { killTreeAsync, listTreePidsAsync } from './processTree.js';
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
  private baseline: Set<number> | null = null;
  private baselinePending = false;
  private cleanupPending = false;
  private queued: string[] = [];
  private readonly listTreeFn: (pid: number) => Promise<number[]>;
  private readonly killTreeFn: (pid: number) => Promise<{ ok: boolean; output: string }>;
  private killing = false;
  private killPromise: Promise<void> | null = null;
  private interruptPromise: Promise<'interrupted' | 'killed'> | null = null;

  static start(opts: SessionOptions): ClaudeSession { return new ClaudeSession(opts); }

  private constructor(opts: SessionOptions) {
    super();
    this.logPath = opts.logPath;
    this.listTreeFn = opts.listTree ?? listTreePidsAsync;
    this.killTreeFn = opts.killTree ?? killTreeAsync;
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
      this.status = 'exited';
      this.exitCode = code;
      setTimeout(() => this.finalize(code), 500).unref(); // fallback if inherited pipes keep 'close' from firing
    });
    this.child.on('close', (code: number | null) => this.finalize(code ?? this.exitCode));
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
      this.startBaseline();
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

  /** Snapshot of descendants taken after init. A snapshot without our own pid is a failed one: baseline stays null. */
  private startBaseline(): void {
    if (this.baseline !== null || this.baselinePending || this.pid <= 0) return;
    this.baselinePending = true;
    void this.listTreeFn(this.pid).then(pids => {
      if (pids.includes(this.pid)) this.baseline = new Set(pids);
      else this.log('[session] baseline snapshot failed; interrupt cleanup disabled until a retry succeeds');
    }, () => { /* treated as failed */ }).finally(() => { this.baselinePending = false; });
  }

  private write(data: string): void {
    if (this.status === 'exited' || this.stdinEnded || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new SessionClosed();
    }
    // While post-interrupt cleanup is pending, hold writes so the next turn's children can't be caught by it.
    if (this.cleanupPending) this.queued.push(data);
    else this.child.stdin.write(data);
  }

  send(text: string): void {
    if (this.baseline === null) this.startBaseline(); // retry a failed/missing baseline at turn start
    this.write(encodeUserMessage(text));
    this.status = 'busy';
  }

  answerPermission(requestId: string, decision: { allow: true; input: unknown } | { allow: false; message: string }): void {
    this.write(decision.allow ? encodePermissionAllow(requestId, decision.input) : encodePermissionDeny(requestId, decision.message));
  }

  interrupt(timeoutMs = 5000): Promise<'interrupted' | 'killed'> {
    if (this.status === 'exited') return Promise.resolve('killed');
    // Nothing to interrupt: don't write (the CLI would never answer and we would kill the session after the timeout).
    if (this.status === 'idle' || this.status === 'starting') return Promise.resolve('interrupted');
    if (this.interruptPromise) return this.interruptPromise;
    const p = new Promise<'interrupted' | 'killed'>(resolve => {
      let done = false;
      const settle = (v: 'interrupted' | 'killed'): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('event', onEvent);
        this.off('exit', onExit);
        resolve(v);
      };
      const onEvent = (ev: StreamEvent): void => {
        if (ev.kind !== 'result' || this.killing) return;
        // Snapshot first (async, outside this handler), then settle, then kill the diff.
        this.cleanupPending = true;
        void this.cleanupToolChildren().then(kill => {
          if (this.killing || done) return;
          settle('interrupted');
          return kill();
        }).catch(() => { /* best effort */ }).finally(() => this.endCleanup());
      };
      const onExit = (): void => settle('killed');
      const timer = setTimeout(() => {
        this.killing = true; // from here only 'killed' may settle
        this.off('event', onEvent);
        void this.kill().then(() => settle('killed'));
      }, timeoutMs);
      this.on('event', onEvent);
      this.on('exit', onExit);
      try {
        this.write(encodeInterrupt(`maestro-int-${randomUUID()}`));
      } catch {
        this.killing = true;
        this.off('event', onEvent);
        void this.kill().then(() => settle('killed'));
      }
    }).finally(() => { this.interruptPromise = null; this.killing = false; });
    this.interruptPromise = p;
    return p;
  }

  private endCleanup(): void {
    this.cleanupPending = false;
    const q = this.queued.splice(0);
    if (this.status === 'exited' || this.stdinEnded || this.child.stdin.destroyed) return;
    for (const d of q) this.child.stdin.write(d);
  }

  /**
   * Snapshots descendants now; returns a function that kills those that appeared since the post-init baseline
   * (tool children), sparing e.g. stdio MCP servers. With no baseline nothing is killed.
   */
  private async cleanupToolChildren(): Promise<() => Promise<void>> {
    const baseline = this.baseline;
    if (!baseline) {
      this.log('[session] interrupt cleanup skipped: baseline not ready');
      return async () => { /* nothing */ };
    }
    const now = await this.listTreeFn(this.pid);
    if (!now.includes(this.pid)) {
      this.log('[session] interrupt cleanup skipped: post-interrupt snapshot failed');
      return async () => { /* nothing */ };
    }
    const extra = now.filter(pid => pid !== this.pid && !baseline.has(pid));
    return async () => { await Promise.all(extra.map(pid => this.killTreeFn(pid))); };
  }

  /**
   * Ends stdin. Allowed while starting/idle, a no-op once exited or already ended,
   * and throws when busy (interrupt first).
   */
  close(): void {
    if (this.status === 'busy') throw new Error('Cannot close a busy session: interrupt() it first');
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
