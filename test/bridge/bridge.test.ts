import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CONDUCTOR_TOOLS, TASK_TOOLS, type BridgeHandlers, type DispatchInput, type TaskSummary,
} from '../../src/bridge/tools.js';
import { startBridgeHttp, writeBridgeConfig } from '../../src/bridge/http.js';

const SPIKE = fileURLToPath(new URL('../../spikes/r1-conductor/bridge.ts', import.meta.url));

interface Recorded { tool: string; missionId: string; taskId?: string | null; args: unknown }

function fakeHandlers(over: Partial<BridgeHandlers> = {}): { h: BridgeHandlers; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const h: BridgeHandlers = {
    async submitPlan(missionId, planPath) { calls.push({ tool: 'submit_plan', missionId, args: planPath }); return { approved: true }; },
    async dispatchTask(missionId, d: DispatchInput) { calls.push({ tool: 'dispatch_task', missionId, args: d }); return { task_ref: `ref-${d.task_id}` }; },
    async waitForTasks(missionId, refs, mode) {
      calls.push({ tool: 'wait_for_tasks', missionId, args: { refs, mode } });
      return refs.map((r): TaskSummary => ({ task_ref: r, key: r, status: 'done', handoff: 'ok', branch: null, commits: [], failure_reason: null }));
    },
    async askUser(missionId, taskId, q) { calls.push({ tool: 'ask_user', missionId, taskId, args: q }); return 'yes'; },
    async finishMission(missionId, summary) { calls.push({ tool: 'finish_mission', missionId, args: summary }); return 'keep'; },
    ...over,
  };
  return { h, calls };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startHttp(h: BridgeHandlers) {
  const b = await startBridgeHttp(h);
  cleanups.push(() => b.close());
  return b;
}

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'maestro-bridge-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function connectClient(cfgPath: string, extraEnv: Record<string, string> = {}): Promise<Client> {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const s = cfg.mcpServers.maestro;
  const transport = new StdioClientTransport({ command: s.command, args: s.args, env: { ...s.env, ...extraEnv }, cwd: tmpdir(), stderr: 'pipe' }); // not the repo: like a worktree cwd
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

const post = (port: number, tool: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/tool/${tool}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('bridge', () => {
  it('tool descriptions match spikes/r1-conductor/bridge.ts verbatim', () => {
    const src = readFileSync(SPIKE, 'utf8');
    const spike = new Map<string, string>();
    for (const m of src.matchAll(/server\.tool\('([a-z_]+)', '((?:[^'\\]|\\.)*)'/g)) spike.set(m[1]!, m[2]!);
    expect([...spike.keys()].sort()).toEqual(['ask_user', 'dispatch_task', 'wait_for_tasks']);
    for (const [name, desc] of spike) {
      expect(CONDUCTOR_TOOLS.find((t) => t.name === name)?.description).toBe(desc);
    }
    expect(TASK_TOOLS.find((t) => t.name === 'ask_user')?.description).toBe(spike.get('ask_user'));
    expect(CONDUCTOR_TOOLS.map((t) => t.name)).toEqual(['submit_plan', 'dispatch_task', 'wait_for_tasks', 'ask_user', 'finish_mission']);
  });

  it('rejects requests without the token', async () => {
    const { h, calls } = fakeHandlers();
    const b = await startHttp(h);
    expect(b.token).toMatch(/^[0-9a-f]{64}$/);
    const body = { missionId: 'm1', taskId: null, args: { question: 'q?' } };
    expect((await post(b.port, 'ask_user', body)).status).toBe(401);
    expect((await post(b.port, 'ask_user', body, { 'x-maestro-token': 'nope' })).status).toBe(401);
    expect((await post(b.port, 'ask_user', body, { 'x-maestro-token': b.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).status).toBe(401);
    expect(calls).toEqual([]);
    const ok = await post(b.port, 'ask_user', body, { 'x-maestro-token': b.token });
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('binds 127.0.0.1 only', async () => {
    const { h } = fakeHandlers();
    const b = await startHttp(h);
    expect(b.address).toBe('127.0.0.1');
  });

  it('rejects oversized bodies, unknown tools, bad args, and reports handler errors as tool errors', async () => {
    const { h } = fakeHandlers({ async finishMission() { throw new Error('boom'); } });
    const b = await startHttp(h);
    const auth = { 'x-maestro-token': b.token };
    const big = JSON.stringify({ missionId: 'm1', args: { question: 'x'.repeat(1024 * 1024 + 10) } });
    expect((await post(b.port, 'ask_user', big, auth)).status).toBe(413);
    expect((await post(b.port, 'nope', { missionId: 'm1', args: {} }, auth)).status).toBe(404);

    const bad = await post(b.port, 'dispatch_task', { missionId: 'm1', args: { task_id: 'T1' } }, auth);
    expect(bad.status).toBe(200);
    expect((await bad.json()).isError).toBe(true);

    const err = await post(b.port, 'finish_mission', { missionId: 'm1', args: { summary: 's' } }, auth);
    expect(err.status).toBe(200);
    const j = await err.json();
    expect(j.isError).toBe(true);
    expect(j.text).toContain('boom');

    // A task session's bridge may only call task tools.
    const t = await post(b.port, 'dispatch_task', { missionId: 'm1', taskId: 'T9', args: { task_id: 'T1', agent: 'a', prompt: 'p' } }, auth);
    expect(t.status).toBe(403);
    // Server is still alive.
    expect((await post(b.port, 'ask_user', { missionId: 'm1', args: { question: 'q' } }, auth)).status).toBe(200);
  });

  it('writes a bridge config with the token in env only', async () => {
    const dir = tmp();
    const p = writeBridgeConfig(dir, { port: 1234, token: 'tok', missionId: 'm1', taskId: 'T1', tools: 'task' });
    expect(p).toBe(join(dir, 'bridge.json'));
    const s = JSON.parse(readFileSync(p, 'utf8')).mcpServers.maestro;
    expect(s.command).toBe(process.execPath);
    expect(s.args[0]).toBe('--import');
    expect(s.args[1]).toBe(import.meta.resolve('tsx'));
    expect(s.args[2]).toMatch(/src[\\/]bridge[\\/]stdio\.ts$/);
    expect(s.args.join(' ')).not.toContain('tok');
    expect(s.env).toEqual({ MAESTRO_BRIDGE_PORT: '1234', MAESTRO_BRIDGE_TOKEN: 'tok', MAESTRO_MISSION_ID: 'm1', MAESTRO_TASK_ID: 'T1', MAESTRO_BRIDGE_TOOLS: 'task' });
  });

  it('forwards a dispatch_task call end to end through a real stdio MCP client', async () => {
    const { h, calls } = fakeHandlers();
    const b = await startHttp(h);
    const cfg = writeBridgeConfig(tmp(), { port: b.port, token: b.token, missionId: 'm1', tools: 'conductor' });
    const client = await connectClient(cfg);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(CONDUCTOR_TOOLS.map((t) => t.name));
    for (const t of listed.tools) expect(t.description).toBe(CONDUCTOR_TOOLS.find((d) => d.name === t.name)!.description);

    const res = await client.callTool({ name: 'dispatch_task', arguments: { task_id: 'T1', agent: 'implementer', prompt: 'do it', owns: ['src/**'] } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toEqual({ task_ref: 'ref-T1' });
    expect(calls).toEqual([{ tool: 'dispatch_task', missionId: 'm1', args: { task_id: 'T1', agent: 'implementer', prompt: 'do it', depends_on: [], owns: ['src/**'] } }]);
  }, 15_000);

  it('wait_for_tasks sends progress while blocking', async () => {
    const { h } = fakeHandlers({
      async waitForTasks(_m, refs) {
        await new Promise((r) => setTimeout(r, 600));
        return refs.map((r): TaskSummary => ({ task_ref: r, key: 'T1', status: 'done', handoff: 'h', branch: 'b', commits: ['c1'], failure_reason: null }));
      },
    });
    const b = await startHttp(h);
    const cfg = writeBridgeConfig(tmp(), { port: b.port, token: b.token, missionId: 'm1', tools: 'conductor' });
    const client = await connectClient(cfg, { MAESTRO_BRIDGE_PROGRESS_MS: '50' });
    let progress = 0;
    const res = await client.callTool({ name: 'wait_for_tasks', arguments: { task_refs: ['ref-T1'], mode: 'all' } }, undefined, {
      onprogress: () => { progress++; },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)[0]).toMatchObject({ task_ref: 'ref-T1', status: 'done', commits: ['c1'] });
    expect(progress).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it('forwards handler progress as MCP progress notifications', async () => {
    const { h } = fakeHandlers({
      async waitForTasks(_m, refs, _mode, onProgress) {
        for (let i = 0; i < 3; i++) { onProgress(); await new Promise((r) => setTimeout(r, 30)); }
        return refs.map((r): TaskSummary => ({ task_ref: r, key: 'T1', status: 'failed', handoff: null, branch: null, commits: [], failure_reason: 'x' }));
      },
    });
    const b = await startHttp(h);
    const cfg = writeBridgeConfig(tmp(), { port: b.port, token: b.token, missionId: 'm1', tools: 'conductor' });
    const client = await connectClient(cfg); // default 60 s interval: only the handler's progress arrives
    let progress = 0;
    const res = await client.callTool({ name: 'wait_for_tasks', arguments: { task_refs: ['ref-T1'] } }, undefined, { onprogress: () => { progress++; } });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)[0].status).toBe('failed');
    expect(progress).toBe(3);
  }, 15_000);

  it('task bridge exposes only ask_user', async () => {
    expect(TASK_TOOLS.map((t) => t.name)).toEqual(['ask_user']);
    const { h, calls } = fakeHandlers();
    const b = await startHttp(h);
    const cfg = writeBridgeConfig(tmp(), { port: b.port, token: b.token, missionId: 'm1', taskId: 'T2', tools: 'task' });
    const client = await connectClient(cfg);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ask_user']);
    const res = await client.callTool({ name: 'ask_user', arguments: { question: 'Which?', options: ['a', 'b'] } });
    expect((res.content as { text: string }[])[0]!.text).toBe('yes');
    expect(calls).toEqual([{ tool: 'ask_user', missionId: 'm1', taskId: 'T2', args: { question: 'Which?', options: ['a', 'b'] } }]);
  }, 15_000);
});
