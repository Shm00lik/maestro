// One long-lived claude.exe stream-json process. Stopping is only via stdin interrupt / stdin end / killTree
// (never child.kill() or SIGINT: they orphan grandchildren on Windows).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveClaudeCommand } from './exe.js';
import { killTree, listTreePids } from './processTree.js';
import {
  encodeInterrupt, encodePermissionAllow, encodePermissionDeny, encodeUserMessage, parseEvent, type StreamEvent,
} from './protocol.js';

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
  private killPromise: Promise<void> | null = null;
  private interruptPromise: Promise<'interrupted' | 'killed'> | null = null;

  static start(opts: SessionOptions): ClaudeSession { return new ClaudeSession(opts); }

  private constructor(opts: SessionOptions) {
    super();
    this.logPath = opts.logPath;
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
    this.child.stdout.on('data', (d: string) => { this.outBuf = this.lines(this.outBuf + d, false); });
    this.child.stderr.on('data', (d: string) => { this.errBuf = this.lines(this.errBuf + d, true); });
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
    this.emit('error', e);
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

  private write(data: string): void {
    if (this.status === 'exited' || this.stdinEnded || this.child.stdin.destroyed || !this.child.stdin.writable) {
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

  interrupt(timeoutMs = 5000): Promise<'interrupted' | 'killed'> {
    if (this.status === 'exited') return Promise.resolve('killed');
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
        if (ev.kind !== 'result') return;
        // Tool children may outlive the interrupt; claude's own cleanup is unverified.
        try {
          for (const pid of listTreePids(this.pid)) if (pid !== this.pid) killTree(pid);
        } catch { /* best effort */ }
        settle('interrupted');
      };
      const onExit = (): void => settle('killed');
      const timer = setTimeout(() => { void this.kill().then(() => settle('killed')); }, timeoutMs);
      this.on('event', onEvent);
      this.on('exit', onExit);
      try {
        this.write(encodeInterrupt(`maestro-int-${randomUUID()}`));
      } catch {
        void this.kill().then(() => settle('killed'));
      }
    }).finally(() => { this.interruptPromise = null; });
    this.interruptPromise = p;
    return p;
  }

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
        if (this.pid > 0) killTree(this.pid);
      }
    });
    return this.killPromise;
  }
}
