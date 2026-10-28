import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEvent } from '../../src/claude/protocol.js';

const FAKE = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));
const scenarioFile = (name: string): string => fileURLToPath(new URL(`../fixtures/scenarios/${name}.json`, import.meta.url));

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fake-claude-')); });
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill(); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

interface Fake {
  proc: ChildProcess;
  out: any[];
  send(obj: unknown): void;
  waitForOut(n: number): Promise<void>;
  exited: Promise<number | null>;
  logLines(): any[];
}

function start(scenario: string | object, args: string[] = []): Fake {
  const sc = typeof scenario === 'string' ? scenarioFile(scenario) : join(dir, 'inline.json');
  if (typeof scenario !== 'string') writeFileSync(sc, JSON.stringify(scenario));
  const logPath = join(dir, 'log.jsonl');
  const proc = spawn(process.execPath, ['--import', 'tsx', FAKE, ...args], {
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: sc, FAKE_CLAUDE_LOG: logPath },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  children.push(proc);
  const out: any[] = [];
  const waiters: Array<() => void> = [];
  let buf = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      out.push(JSON.parse(buf.slice(0, i))); // throws (fails test) on a partial/invalid line
      buf = buf.slice(i + 1);
    }
    waiters.splice(0).forEach(w => w());
  });
  const exited = new Promise<number | null>(r => proc.on('close', code => r(code)));
  return {
    proc, out, exited,
    send: o => { proc.stdin!.write(JSON.stringify(o) + '\n'); },
    waitForOut: async n => { while (out.length < n) await new Promise<void>(r => waiters.push(r)); },
    logLines: () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
  };
}

describe('fake-claude', () => {
  it('emits init then result', async () => {
    const f = start('init-result');
    await f.waitForOut(2);
    expect(f.out.map(e => parseEvent(JSON.stringify(e))!.kind)).toEqual(['init', 'result']);
    expect(f.out[1].session_id).toBe('fake-session-1'); // $SESSION substituted
    f.proc.stdin!.end();
    expect(await f.exited).toBe(0);
    expect(f.logLines()[0]).toEqual({ argv: [] });
  });

  it('honours --resume for the init session id and records argv', async () => {
    const f = start('init-result', ['--resume', 'resumed-123', '--tools', 'Bash']);
    await f.waitForOut(2);
    expect(f.out[0].session_id).toBe('resumed-123');
    expect(f.out[1].session_id).toBe('resumed-123');
    f.proc.stdin!.end();
    await f.exited;
    expect(f.logLines()[0]).toEqual({ argv: ['--resume', 'resumed-123', '--tools', 'Bash'] });
  });

  it('echoes a user message with isReplay', async () => {
    const f = start('user-echo');
    await f.waitForOut(1);
    f.send({ type: 'user', message: { role: 'user', content: 'hello' } });
    await f.waitForOut(3);
    const echo = f.out[1];
    expect(parseEvent(JSON.stringify(echo))!.kind).toBe('user-echo');
    expect(echo.isReplay).toBe(true);
    expect(echo.message.content).toBe('hello');
    expect(f.out[2].type).toBe('result');
    f.proc.stdin!.end();
    expect(await f.exited).toBe(0);
    expect(f.logLines()[1]).toMatchObject({ type: 'user' });
  });

  it('answers an interrupt with control_response then an aborted_tools result', async () => {
    const f = start('interrupt');
    await f.waitForOut(1);
    f.send({ type: 'user', message: { role: 'user', content: 'go' } });
    await f.waitForOut(2);
    f.send({ type: 'control_request', request_id: 'int-7', request: { subtype: 'interrupt' } });
    await f.waitForOut(4);
    expect(f.out[2]).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'int-7', response: { still_queued: [] } } });
    expect(f.out[3]).toMatchObject({ type: 'result', terminal_reason: 'aborted_tools', session_id: 'fake-session-1' });
    f.proc.stdin!.end();
    expect(await f.exited).toBe(0);
  });

  it('blocks on a can_use_tool request until the answer arrives', async () => {
    const f = start('permission');
    await f.waitForOut(2);
    expect(parseEvent(JSON.stringify(f.out[1]))!.kind).toBe('permission-request');
    await new Promise(r => setTimeout(r, 300));
    expect(f.out).toHaveLength(2); // still blocked
    f.send({ type: 'control_response', response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow', updatedInput: {} } } });
    await f.waitForOut(3);
    expect(f.out[2].type).toBe('result');
    f.proc.stdin!.end();
    expect(await f.exited).toBe(0);
    expect(f.logLines().some(l => l.type === 'control_response')).toBe(true);
  });

  it('exits 0 when stdin closes while idle', async () => {
    const f = start('idle');
    await f.waitForOut(1);
    f.proc.stdin!.end();
    expect(await f.exited).toBe(0);
    expect(f.out).toHaveLength(1);
  });

  it('substitutes $REQUEST_ID in templated emits and ignores unexpected lines', async () => {
    const f = start({ steps: [
      { waitFor: 'interrupt' },
      { emit: { type: 'x', id: '$REQUEST_ID', s: '$SESSION' }, templated: true },
      { exit: 7 },
    ] });
    f.send({ type: 'whatever' });
    f.send({ type: 'control_request', request_id: 'abc', request: { subtype: 'interrupt' } });
    expect(await f.exited).toBe(7);
    expect(f.out[1]).toMatchObject({ type: 'x', id: 'abc' });
    expect(f.logLines().filter(l => l.type === 'whatever')).toHaveLength(1);
  });

  it('spawns a real child process that outlives a step', async () => {
    const f = start('spawn-child');
    await f.waitForOut(2);
    const pid = f.logLines().find(l => l.spawnedChild)?.spawnedChild as number;
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    try { process.kill(pid); } catch { /* already gone */ }
    f.proc.stdin!.end();
    expect(await f.exited).toBe(0);
  });
});
