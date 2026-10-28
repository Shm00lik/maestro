import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_ARGS, ClaudeSession, SessionClosed, type SessionOptions } from '../../src/claude/session.js';
import { killTree } from '../../src/claude/processTree.js';
import type { StreamEvent } from '../../src/claude/protocol.js';

const FAKE = fileURLToPath(new URL('../fake-claude/fake-claude.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const scenarioFile = (name: string): string => fileURLToPath(new URL(`../fixtures/scenarios/${name}.json`, import.meta.url));
const command = { exe: process.execPath, prefixArgs: ['--import', TSX, FAKE] };

const INIT = { type: 'system', subtype: 'init', session_id: 'S1', model: 'm', cwd: 'c', tools: [], permissionMode: 'default' };
const RESULT = { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', session_id: 'S1' };

let dir: string;
const sessions: ClaudeSession[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'session-test-')); });
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.kill();
  for (const l of fakeLogLines()) if (typeof l.spawnedChild === 'number') killTree(l.spawnedChild);
  rmSync(dir, { recursive: true, force: true });
});

const fakeLog = (): string => join(dir, 'fake.jsonl');
function fakeLogLines(): any[] {
  try { return readFileSync(fakeLog(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

function start(scenario: string | object, extraArgs: string[] = [], extra: Partial<SessionOptions> = {}): ClaudeSession {
  let sc: string;
  if (typeof scenario === 'string') sc = scenarioFile(scenario);
  else { sc = join(dir, 'inline.json'); writeFileSync(sc, JSON.stringify(scenario)); }
  const s = ClaudeSession.start({
    args: extraArgs, cwd: dir, logPath: join(dir, 'logs', 's.log'), command,
    env: { FAKE_CLAUDE_SCENARIO: sc, FAKE_CLAUDE_LOG: fakeLog() },
    ...extra,
  });
  sessions.push(s);
  return s;
}

const collect = (s: ClaudeSession): StreamEvent[] => { const evs: StreamEvent[] = []; s.on('event', e => evs.push(e)); return evs; };
const until = (s: ClaudeSession, kind: StreamEvent['kind']): Promise<StreamEvent> =>
  new Promise(res => { const f = (e: StreamEvent): void => { if (e.kind === kind) { s.off('event', f); res(e); } }; s.on('event', f); });
const exited = (s: ClaudeSession): Promise<{ code: number | null; killed: boolean }> => new Promise(res => s.once('exit', res));

describe('ClaudeSession', () => {
  it('emits parsed events and records sessionId from init', async () => {
    const s = start('init-result', ['--model', 'x']);
    const evs = collect(s);
    expect(s.status).toBe('starting');
    await until(s, 'result');
    expect(evs.map(e => e.kind)).toEqual(['init', 'result']);
    expect(s.sessionId).toBe('fake-session-1');
    expect(s.status).toBe('idle');
    const argv = fakeLogLines()[0].argv as string[];
    expect(argv.slice(0, BASE_ARGS.length)).toEqual(BASE_ARGS);
    expect(argv.slice(-2)).toEqual(['--model', 'x']);
    expect(readFileSync(join(dir, 'logs', 's.log'), 'utf8')).toContain('"subtype":"init"');
    const ex = exited(s);
    s.close();
    expect((await ex).killed).toBe(false);
  }, 10000);

  it('send while exited throws SessionClosed', async () => {
    const s = start('init-result');
    await until(s, 'result');
    const ex = exited(s);
    s.close();
    await ex;
    expect(s.status).toBe('exited');
    expect(() => s.send('hi')).toThrow(SessionClosed);
    expect(() => s.answerPermission('r', { allow: false, message: 'no' })).toThrow(SessionClosed);
  }, 10000);

  it('interrupt returns interrupted on aborted_tools result', async () => {
    const s = start('interrupt');
    await until(s, 'init');
    s.send('go');
    expect(s.status).toBe('busy');
    expect(await s.interrupt(5000)).toBe('interrupted');
    expect(s.status).toBe('idle');
    const ex = exited(s);
    s.close();
    expect((await ex).killed).toBe(false);
  }, 10000);

  it('interrupt falls back to kill after timeout', async () => {
    const s = start({ steps: [{ emit: INIT }, { waitFor: 'user' }, { waitFor: 'stdin-close' }] });
    await until(s, 'init');
    s.send('go');
    const ex = exited(s);
    expect(await s.interrupt(300)).toBe('killed');
    expect(await ex).toMatchObject({ killed: true });
    expect(s.status).toBe('exited');
  }, 10000);

  it('concurrent interrupts send one control_request', async () => {
    const s = start('interrupt');
    await until(s, 'init');
    s.send('go');
    const [a, b] = await Promise.all([s.interrupt(), s.interrupt()]);
    expect([a, b]).toEqual(['interrupted', 'interrupted']);
    expect(fakeLogLines().filter(l => l?.request?.subtype === 'interrupt')).toHaveLength(1);
  }, 10000);

  it('kill is idempotent', async () => {
    const s = start('idle');
    await until(s, 'init');
    const ex = exited(s);
    await Promise.all([s.kill(), s.kill()]);
    await s.kill();
    expect(await ex).toMatchObject({ killed: true });
    expect(s.status).toBe('exited');
  }, 10000);

  it('answerPermission writes the exact control_response', async () => {
    const s = start('permission');
    const req = (await until(s, 'permission-request')) as Extract<StreamEvent, { kind: 'permission-request' }>;
    s.answerPermission(req.requestId, { allow: true, input: { command: 'npm --version' } });
    await until(s, 'result');
    const resp = fakeLogLines().find(l => l?.type === 'control_response');
    expect(resp).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.requestId, response: { behavior: 'allow', updatedInput: { command: 'npm --version' } } },
    });
  }, 10000);

  it('stdout lines split across chunks are reassembled', () => {
    const s = start('idle');
    const evs = collect(s);
    const priv = s as unknown as { child: { stdout: { emit(e: string, d: string): void } } };
    const line = JSON.stringify(INIT) + '\r\n';
    priv.child.stdout.emit('data', line.slice(0, 15));
    expect(evs).toHaveLength(0);
    priv.child.stdout.emit('data', line.slice(15, 40));
    priv.child.stdout.emit('data', line.slice(40));
    expect(evs.filter(e => e.kind === 'init')).toHaveLength(1);
    expect(s.sessionId).toBe('S1');
  }, 10000);

  it('permission-cancel events are emitted', async () => {
    const s = start({ steps: [{ emit: INIT }, { emit: { type: 'control_cancel_request', request_id: 'abc' } }, { waitFor: 'stdin-close' }] });
    const ev = await until(s, 'permission-cancel');
    expect(ev).toEqual({ kind: 'permission-cancel', requestId: 'abc' });
  }, 10000);

  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitUntil = async (cond: () => boolean, ms = 6000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  };
  const baselineReady = (s: ClaudeSession): Promise<void> =>
    waitUntil(() => (s as unknown as { baseline: Set<number> | null }).baseline !== null);
  const children = (): number[] => fakeLogLines().filter(l => typeof l.spawnedChild === 'number').map(l => l.spawnedChild as number);

  it('kills a spawned tool child left behind after an interrupt', async () => {
    const s = start({ steps: [{ emit: INIT }, { waitFor: 'user' }, { spawnChild: 'ping' }, { waitFor: 'interrupt' }, { emit: RESULT }, { waitFor: 'stdin-close' }] });
    await until(s, 'init');
    await baselineReady(s);
    s.send('go');
    await waitUntil(() => children().length === 1);
    const pid = children()[0];
    expect(alive(pid)).toBe(true);
    expect(await s.interrupt(8000)).toBe('interrupted');
    await waitUntil(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    expect(s.status).toBe('idle');
  }, 10000);

  it('a child spawned before the baseline survives the interrupt cleanup', async () => {
    const s = start({ steps: [{ spawnChild: 'ping' }, { emit: INIT }, { waitFor: 'user' }, { spawnChild: 'ping' }, { waitFor: 'interrupt' }, { emit: RESULT }, { waitFor: 'stdin-close' }] });
    await until(s, 'init');
    await baselineReady(s);
    s.send('go');
    await waitUntil(() => children().length === 2);
    const [early, late] = children();
    expect(await s.interrupt(8000)).toBe('interrupted');
    await waitUntil(() => !alive(late));
    expect(alive(late)).toBe(false);
    expect(alive(early)).toBe(true);
  }, 10000);

  it('interrupt after result returns interrupted and the session stays alive', async () => {
    const s = start('idle');
    await until(s, 'init');
    s.send('go');
    await until(s, 'result');
    expect(s.status).toBe('idle');
    expect(await s.interrupt(300)).toBe('interrupted');
    expect(s.status).toBe('idle');
    expect(fakeLogLines().filter(l => l?.request?.subtype === 'interrupt')).toHaveLength(0);
    s.send('again');
    expect(s.status).toBe('busy');
  }, 10000);

  it('a result arriving after the timeout fired still resolves killed', async () => {
    const stubKills: number[] = [];
    const s = start(
      { steps: [{ emit: INIT }, { waitFor: 'user' }, { waitFor: 'interrupt' }, { sleepMs: 400 }, { emit: RESULT }, { waitFor: 'stdin-close' }] },
      [], { killTree: async pid => { stubKills.push(pid); return { ok: true, output: 'stub' }; } },
    );
    await until(s, 'init');
    s.send('go');
    let outcome: string | null = null;
    void s.interrupt(100).then(o => { outcome = o; });
    const gotResult = until(s, 'result');
    await gotResult; // result arrives after the timeout fired; the stub did not kill anything
    await new Promise(r => setTimeout(r, 200));
    expect(stubKills).toContain(s.pid);
    expect(outcome).toBeNull(); // must not settle 'interrupted'
    killTree(s.pid); // really kill now
    await exited(s);
    await waitUntil(() => outcome !== null, 3000);
    expect(outcome).toBe('killed');
  }, 10000);

  it('skips cleanup (kills nothing) when the baseline snapshot failed', async () => {
    const s = start(
      { steps: [{ emit: INIT }, { waitFor: 'user' }, { spawnChild: 'ping' }, { waitFor: 'interrupt' }, { emit: RESULT }, { waitFor: 'stdin-close' }] },
      [], { listTree: async () => [] },
    );
    await until(s, 'init');
    await new Promise(r => setTimeout(r, 300));
    s.send('go');
    await waitUntil(() => children().length === 1);
    const pid = children()[0];
    expect(await s.interrupt(8000)).toBe('interrupted');
    await new Promise(r => setTimeout(r, 500));
    expect(alive(pid)).toBe(true);
    expect(readFileSync(join(dir, 'logs', 's.log'), 'utf8')).toContain('baseline');
  }, 10000);

  it("send right after interrupt does not kill the new turn's tool child", async () => {
    const s = start({ steps: [
      { emit: INIT }, { waitFor: 'user' }, { spawnChild: 'ping' }, { waitFor: 'interrupt' }, { emit: RESULT },
      { waitFor: 'user' }, { spawnChild: 'ping' }, { waitFor: 'stdin-close' },
    ] });
    await until(s, 'init');
    await baselineReady(s);
    s.send('one');
    await waitUntil(() => children().length === 1);
    expect(await s.interrupt(8000)).toBe('interrupted');
    s.send('two');
    expect(s.status).toBe('busy');
    await waitUntil(() => children().length === 2);
    const [first, second] = children();
    await waitUntil(() => !alive(first));
    await new Promise(r => setTimeout(r, 1500));
    expect(alive(first)).toBe(false);
    expect(alive(second)).toBe(true);
  }, 10000);

  it('stdin EPIPE without an error listener does not throw and is logged', async () => {
    const s = start('idle');
    await until(s, 'init');
    const priv = s as unknown as { child: { stdin: { emit(e: string, err: Error): void } } };
    expect(() => priv.child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
    expect(() => priv.child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
    expect(readFileSync(join(dir, 'logs', 's.log'), 'utf8')).toContain('write EPIPE');
  }, 10000);

  it('stdin EPIPE with an error listener emits error once', async () => {
    const s = start('idle');
    await until(s, 'init');
    const errs: Error[] = [];
    s.on('error', e => errs.push(e));
    const priv = s as unknown as { child: { stdin: { emit(e: string, err: Error): void } } };
    priv.child.stdin.emit('error', new Error('EPIPE 1'));
    priv.child.stdin.emit('error', new Error('EPIPE 2'));
    expect(errs).toHaveLength(1);
  }, 10000);
});
