import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveClaudeCommand } from '../../src/claude/exe.js';
import { killPidAsync, killTree, killTreeAsync, listTreePids, listTreePidsAsync } from '../../src/claude/processTree.js';

const win = process.platform === 'win32';
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('processTree', () => {
  it.runIf(win)('killTree kills a spawned process tree with no survivors', async () => {
    const child = spawn('cmd', ['/c', 'ping -n 60 127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    const pid = child.pid!;
    const exited = new Promise<void>(res => child.once('exit', () => res()));
    /** Polls until f() holds or the deadline passes; a loaded full test run can be slow at both ends. */
    const poll = async (f: () => boolean, ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      while (!f()) { if (Date.now() > end) return false; await sleep(250); }
      return true;
    };
    let tree: number[] = [];
    try {
      // Tree formation: cmd plus its ping child (only PIDs this test spawned are asserted on).
      expect(await poll(() => (tree = listTreePids(pid)).length >= 2, 20_000)).toBe(true);
      expect(tree[0]).toBe(pid);
      expect(killTree(pid).ok).toBe(true);
      // Disappearance: the root reports its exit; every PID of the tree leaves the process table.
      await Promise.race([exited, sleep(20_000)]);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      for (const p of tree) expect(await poll(() => listTreePids(p).length === 0, 20_000), `pid ${p}`).toBe(true);
      expect(killTree(pid).ok).toBe(true); // already gone counts as ok
    } finally {
      killTree(pid);
    }
  }, 90_000);

  it.runIf(win)('async tree helpers are bounded by a timeout', async () => {
    expect(await listTreePidsAsync(process.pid, 1)).toEqual([]);
    expect((await killTreeAsync(2147483644, 1)).ok).toBe(false); // timed out, not "not found"
    expect((await killTreeAsync(2147483644)).ok).toBe(true); // "not found" counts as ok
  }, 10000);

  it.runIf(win)('killPidAsync kills only the given pid, not its children', async () => {
    const child = spawn('cmd', ['/c', 'ping -n 60 127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    const pid = child.pid!;
    let tree: number[] = [];
    try {
      for (let i = 0; i < 25 && tree.length < 2; i++) { await sleep(200); tree = listTreePids(pid); }
      expect(tree.length).toBeGreaterThanOrEqual(2);
      expect((await killPidAsync(pid)).ok).toBe(true);
      await sleep(300);
      expect(listTreePids(pid)).toEqual([]);
      expect(tree.slice(1).some(p => listTreePids(p).length > 0)).toBe(true); // a descendant (ping) survives
    } finally {
      killTree(pid);
      for (const p of tree) killTree(p);
    }
  }, 10000);

  it.runIf(win)('spawns in a cwd with spaces and accents', async () => {
    const root = join(tmpdir(), 'maestro test');
    const cwd = join(root, 'été');
    mkdirSync(cwd, { recursive: true });
    const scenario = join(cwd, 'scenario.json');
    writeFileSync(scenario, JSON.stringify({ steps: [{ emit: { type: 'system', subtype: 'init', session_id: 's1' } }, { waitFor: 'stdin-close' }] }));
    const fake = fileURLToPath(new URL('../fake-claude/fake-claude.ts', import.meta.url));
    const saved = { e: process.env.MAESTRO_CLAUDE_EXE, a: process.env.MAESTRO_CLAUDE_EXE_ARGS };
    process.env.MAESTRO_CLAUDE_EXE = process.execPath;
    // absolute tsx URL: bare 'tsx' would resolve from the node_modules-less cwd
    process.env.MAESTRO_CLAUDE_EXE_ARGS = JSON.stringify(['--import', import.meta.resolve('tsx'), fake]);
    let child: ChildProcess | undefined;
    try {
      const { exe, prefixArgs } = resolveClaudeCommand();
      // FAKE_CLAUDE_LOG is relative, so the log lands in the fake's actual cwd.
      child = spawn(exe, [...prefixArgs, '-p'], {
        cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_LOG: 'fake.log' },
      });
      let out = '';
      child.stdout!.on('data', d => { out += d; });
      for (let i = 0; i < 100 && !out.includes('"init"'); i++) await sleep(100);
      expect(out).toContain('"init"');
      expect(existsSync(join(cwd, 'fake.log'))).toBe(true);
      const exited = new Promise(r => child!.on('exit', r));
      child.stdin!.end();
      await exited;
    } finally {
      if (child?.pid) killTree(child.pid);
      for (const [k, v] of [['MAESTRO_CLAUDE_EXE', saved.e], ['MAESTRO_CLAUDE_EXE_ARGS', saved.a]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
