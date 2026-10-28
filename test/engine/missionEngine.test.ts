// MissionEngine integration tests. The conductor is a fake-claude session that just idles (it cannot call MCP
// tools), so each test drives the BridgeHandlers directly, as the conductor would. Task sessions are fake-claude
// scenarios that write a file and end with a `## Handoff`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../../src/store/db.js';
import { events, inbox, missions, projects, tasks, usageWindow, type InboxEntry, type Mission } from '../../src/store/repos.js';
import { Expired } from '../../src/store/repos.js';
import { MissionEngine } from '../../src/engine/missionEngine.js';

const FAKE = fileURLToPath(new URL('../fake-claude/fake-claude.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const command = { exe: process.execPath, prefixArgs: ['--import', TSX, FAKE] };
const T = 20_000;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();

// ---- scenario steps --------------------------------------------------------
const INIT = { emit: { type: 'system', subtype: 'init', model: 'm', cwd: 'c', tools: ['Read', 'Bash', 'Edit', 'Write'], permissionMode: 'default' } };
const USAGE = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const RESULT = (text: string) => ({
  emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: '$SESSION', usage: USAGE },
  templated: true,
});
const ABORTED = {
  emit: { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: '$SESSION', usage: USAGE },
  templated: true,
};
const USER = { waitFor: 'user' };
/** Mid-turn until interrupted (so stop() is quick), like a real long-running session. */
const UNTIL_INTERRUPT = [{ waitFor: 'interrupt', timeoutMs: 120_000 }, ABORTED];
const CONDUCTOR_IDLE = [INIT, USER, ...UNTIL_INTERRUPT];
const TASK_DONE = [INIT, USER, { writeFile: 'out-$SESSION.txt', content: 'work\n' }, RESULT('Did it.\n\n## Handoff\nMade a file.'), { waitFor: 'stdin-close' }];
const TASK_HANG = [INIT, USER, ...UNTIL_INTERRUPT];
const ASSISTANT_TASK_TOOL = {
  emit: {
    type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Task', input: { prompt: 'implement it' } }] },
  },
};
const RATE_LIMITED = {
  emit: {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected', resetsAt: 4_000_000_000,
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: 4_000_000_000 }, seven_day: { utilization: 0.4, resetsAt: 4_100_000_000 } },
    },
  },
};

const PLAN = `# Plan

### Task 1: Part A
Depends on: none
Agent: implementer
Owns: a/**
Acceptance: a works

Build part A.

### Task 2: Part B
Depends on: none
Agent: implementer
Owns: b/**
Acceptance: b works

Build part B.

### Task 3: Join
Depends on: T1, T2
Agent: implementer
Owns: c/**
Acceptance: c works

Join A and B.
`;
const PLAN_SRC = `# Plan

### Task 1: Src
Depends on: none
Agent: implementer
Owns: src/**
Acceptance: src works

Do src.
`;
const BAD_PLAN = `# Plan

### Task 1: One
Depends on: T2
Agent: implementer
Owns: a/**
Acceptance: ok

### Task 2: Two
Depends on: T1
Agent: wizard
Owns: b/**
Acceptance:
`;

// ---- fixture ---------------------------------------------------------------
let dir: string;
let root: string;
let db: Db;
let engine: MissionEngine | null = null;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-engine-'));
  root = mkdtempSync(join(tmpdir(), 'maestro-engine-repo-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'readme.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  db = openDb(':memory:');
  projectId = projects.add(db, { name: 'demo', path: root }).id;
});

afterEach(async () => {
  if (engine) { await engine.close(); engine = null; }
  db.close();
  try {
    const wts = git(root, 'worktree', 'list', '--porcelain').split('\n')
      .filter(l => l.startsWith('worktree ')).map(l => l.slice(9).trim()).slice(1);
    for (const w of wts) { try { git(root, 'worktree', 'remove', '--force', w); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function makeEngine(taskSteps: object[], conductorSteps: object[] = CONDUCTOR_IDLE): MissionEngine {
  const taskScenario = join(dir, 'task-scenario.json');
  const condScenario = join(dir, 'conductor-scenario.json');
  writeFileSync(taskScenario, JSON.stringify({ steps: taskSteps }));
  writeFileSync(condScenario, JSON.stringify({ steps: conductorSteps }));
  engine = new MissionEngine({
    db, logDir: join(dir, 'logs'), command, stopTimeoutMs: 1500, progressMs: 100,
    env: { FAKE_CLAUDE_SCENARIO: taskScenario, FAKE_CLAUDE_LOG: join(dir, 'fake.jsonl') },
    conductorEnv: { FAKE_CLAUDE_SCENARIO: condScenario, FAKE_CLAUDE_LOG: join(dir, 'conductor.jsonl') },
  });
  return engine;
}

const start = (e: MissionEngine, title = 'Fix login'): Promise<Mission> => e.startMission({
  projectId, title, brief: 'Make login work.', depth: 'thorough', baseBranch: 'main', missionBranch: '',
  isolation: 'worktree', maxParallel: 3, quick: true,
});

const writePlan = (text: string, name = 'plan.md'): string => {
  const p = join(dir, name); // outside the repo, so the main checkout stays clean
  writeFileSync(p, text);
  return p;
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('until: timed out');
    await sleep(25);
  }
}
const openEntry = (missionId: string, kind: string): InboxEntry | undefined =>
  inbox.listOpen(db, Date.now()).find(e => e.missionId === missionId && e.kind === kind);
const pending = async (p: Promise<unknown>): Promise<boolean> =>
  Promise.race([p.then(() => false, () => false), sleep(200).then(() => true)]);
const mission = (id: string): Mission => missions.get(db, id)!;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function approved(e: MissionEngine, m: Mission, plan: string): Promise<void> {
  const res = e.submitPlan(m.id, writePlan(plan));
  await until(() => openEntry(m.id, 'plan_approval'));
  e.approvePlan(m.id);
  expect(await res).toEqual({ approved: true });
}

describe('MissionEngine', () => {
  it('submit_plan rejects invalid plans with errors and blocks valid ones until approve', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    expect(m.missionBranch).toBe('maestro/fix-login');
    expect(git(root, 'rev-parse', 'maestro/fix-login')).toBe(git(root, 'rev-parse', 'main'));
    expect(m.state).toBe('planning');

    const bad = await e.submitPlan(m.id, writePlan(BAD_PLAN, 'bad.md'));
    expect('errors' in bad && bad.errors.map(x => x.code)).toEqual(
      expect.arrayContaining(['cycle', 'unknown-agent', 'missing-acceptance']));
    expect(mission(m.id).state).toBe('planning');
    expect(openEntry(m.id, 'plan_approval')).toBeUndefined();

    const res = e.submitPlan(m.id, writePlan(PLAN));
    expect(await pending(res)).toBe(true);
    const entry = await until(() => openEntry(m.id, 'plan_approval'));
    expect(mission(m.id).state).toBe('awaiting_approval');
    expect(tasks.listByMission(db, m.id).map(t => [t.taskKey, t.state])).toEqual(
      [['T1', 'planned'], ['T2', 'planned'], ['T3', 'planned']]);

    e.approvePlan(m.id);
    expect(await res).toEqual({ approved: true });
    expect(mission(m.id).state).toBe('running');
    expect(inbox.get(db, entry.id)!.state).toBe('answered');
    const pv = db.prepare('SELECT approved_at FROM plan_versions WHERE mission_id = ?').all(m.id) as { approved_at: number | null }[];
    expect(pv).toHaveLength(1);
    expect(pv[0].approved_at).not.toBeNull();
  }, T);

  it('submit_plan re-call after timeout resumes the same wait', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    const path = writePlan(PLAN);
    const first = e.submitPlan(m.id, path);
    await until(() => openEntry(m.id, 'plan_approval'));
    // The bridge call timed out; the conductor calls again with the same plan.
    const second = e.submitPlan(m.id, path);
    expect(await pending(second)).toBe(true);
    expect(inbox.listOpen(db, Date.now()).filter(x => x.kind === 'plan_approval')).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM plan_versions WHERE mission_id = ?').get(m.id) as { n: number }).n).toBe(1);

    e.replan(m.id, 'Split part A');
    expect(await second).toEqual({ approved: false, note: 'Split part A' });
    expect(await first).toEqual({ approved: false, note: 'Split part A' });
    expect(mission(m.id).state).toBe('planning');

    // The revised plan becomes version 2 and is applied as a re-plan.
    const third = e.submitPlan(m.id, writePlan(PLAN_SRC, 'plan2.md'));
    await until(() => openEntry(m.id, 'plan_approval'));
    e.approvePlan(m.id);
    expect(await third).toEqual({ approved: true });
    expect(tasks.listByMission(db, m.id).map(t => [t.taskKey, t.state])).toEqual(
      [['T1', 'planned'], ['T2', 'cancelled'], ['T3', 'cancelled']]);
  }, T);

  it('dispatch_task rejects ownership overlap with a running task', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    const r1 = await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'Do src.', depends_on: [], owns: ['src/**'] });
    expect('task_ref' in r1).toBe(true);
    const ref1 = (r1 as { task_ref: string }).task_ref;
    await until(() => tasks.get(db, ref1)!.state === 'running');

    await expect(e.dispatchTask(m.id, { task_id: 'T1-fix', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['SRC/a.ts'] }))
      .rejects.toThrow(/overlap/i);
    expect(tasks.getByKey(db, m.id, 'T1-fix')).toBeUndefined();

    // A dependent task may own the same files; a disjoint one is fine too.
    const rev = await e.dispatchTask(m.id, { task_id: 'T1-review', agent: 'code-reviewer', prompt: 'p', depends_on: ['T1'], owns: ['src/**'] });
    expect(tasks.get(db, (rev as { task_ref: string }).task_ref)!.state).toBe('waiting');
    await e.dispatchTask(m.id, { task_id: 'T1-docs', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['docs/**'] });
    // Re-dispatching returns the existing ref.
    expect(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'x', depends_on: [], owns: ['src/**'] }))
      .toEqual({ task_ref: ref1 });
    // Unknown dependency keys are tool errors too.
    await expect(e.dispatchTask(m.id, { task_id: 'T9', agent: 'implementer', prompt: 'p', depends_on: ['T42'], owns: [] }))
      .rejects.toThrow(/unknown dependency/i);
  }, T);

  it('runs a 3-task mission on fake-claude to finishing and merges on Merge', async () => {
    const e = makeEngine(TASK_DONE);
    const m = await start(e);
    await approved(e, m, PLAN);
    const d = (key: string, deps: string[], owns: string[]) =>
      e.dispatchTask(m.id, { task_id: key, agent: 'implementer', prompt: `Do ${key}.`, depends_on: deps, owns })
        .then(r => (r as { task_ref: string }).task_ref);
    const ref1 = await d('T1', [], ['a/**']);
    const ref2 = await d('T2', [], ['b/**']);
    let progress = 0;
    const s12 = await e.waitForTasks(m.id, [ref1, ref2], 'all', () => { progress++; });
    expect(s12.map(s => [s.key, s.status, s.failure_reason])).toEqual([["T1","done",null],["T2","done",null]]);
    expect(s12.map(s => [s.key, s.status])).toEqual([['T1', 'done'], ['T2', 'done']]);
    expect(s12[0].handoff).toContain('Made a file.');
    expect(s12[0].branch).toBe('maestro/fix-login--T1');
    expect(s12[0].commits).toHaveLength(1);
    expect(s12[0].failure_reason).toBeNull();
    // Idempotent: a re-call returns at once with the same result.
    expect((await e.waitForTasks(m.id, [ref1, ref2], 'all', () => {})).map(s => s.status)).toEqual(['done', 'done']);

    const ref3 = await d('T3', ['T1', 'T2'], ['c/**']);
    const [s3] = await e.waitForTasks(m.id, [ref3], 'any', () => {});
    expect(s3.status).toBe('done');
    expect(s3.commits).toHaveLength(1);

    const fin = e.finishMission(m.id, 'All three parts are in.');
    const entry = await until(() => openEntry(m.id, 'merge_decision'));
    expect(mission(m.id).state).toBe('finishing');
    expect((entry.payload as { options: string[] }).options).toEqual(['Merge', 'Keep branch']);
    await e.answerMergeDecision(entry.id, 'Merge');
    expect(await fin).toBe('merge');
    const done = mission(m.id);
    expect([done.state, done.outcome]).toEqual(['done', 'merged']);
    expect(git(root, 'log', '-1', '--format=%s', 'main')).toBe('Maestro: Fix login');
    const files = git(root, 'ls-tree', '--name-only', 'main').split('\n').filter(f => f.startsWith('out-'));
    expect(files).toHaveLength(3);
    expect(git(root, 'worktree', 'list')).not.toMatch(/integration/);
    expect(progress).toBeGreaterThan(0);
    // Conductor per spec §7.1; task bridges carry only ask_user.
    const condArgv: string[] = JSON.parse(readFileSync(join(dir, 'conductor.jsonl'), 'utf8').split('\n')[0]).argv;
    expect(condArgv.join(' ')).toMatch(/--model opus/);
    expect(condArgv.join(' ')).toMatch(/--permission-mode default/);
    expect(condArgv[condArgv.indexOf('--mcp-config') + 1]).toBe(join(dir, 'logs', 'missions', m.id, 'bridge.json'));
    expect(condArgv[condArgv.indexOf('--append-system-prompt-file') + 1]).toMatch(/prompts[\\/]conductor\.md$/);
    const taskCfg = JSON.parse(readFileSync(join(dir, 'logs', 'tasks', ref1, 'bridge.json'), 'utf8'));
    expect(taskCfg.mcpServers.maestro.env).toMatchObject({ MAESTRO_MISSION_ID: m.id, MAESTRO_TASK_ID: ref1, MAESTRO_BRIDGE_TOOLS: 'task' });
  }, T);

  it('keep ends the mission done with outcome kept and base branch untouched', async () => {
    const e = makeEngine(TASK_DONE);
    const m = await start(e);
    const base = git(root, 'rev-parse', 'main');
    await approved(e, m, PLAN_SRC);
    const r = await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'Do it.', depends_on: [], owns: ['src/**'] });
    const [s] = await e.waitForTasks(m.id, [(r as { task_ref: string }).task_ref], 'all', () => {});
    expect(s.status).toBe('done');

    const fin = e.finishMission(m.id, 'Done.');
    const entry = await until(() => openEntry(m.id, 'merge_decision'));
    await e.answerMergeDecision(entry.id, 'Keep branch');
    expect(await fin).toBe('keep');
    const done = mission(m.id);
    expect([done.state, done.outcome]).toEqual(['done', 'kept']);
    expect(git(root, 'rev-parse', 'main')).toBe(base);
    expect(git(root, 'rev-parse', 'maestro/fix-login')).not.toBe(base);
  }, T);

  it('asks again when the base branch cannot be merged in place, then merges in a temporary worktree', async () => {
    const e = makeEngine(TASK_DONE);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    const r = await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'Do it.', depends_on: [], owns: ['src/**'] });
    await e.waitForTasks(m.id, [(r as { task_ref: string }).task_ref], 'all', () => {});
    const fin = e.finishMission(m.id, 'Done.');
    const first = await until(() => openEntry(m.id, 'merge_decision'));

    writeFileSync(join(root, 'local-edit.txt'), 'uncommitted\n'); // main is checked out here, and dirty
    expect(await e.answerMergeDecision(first.id, 'Merge')).toMatchObject({ outcome: 'retry' });
    const second = await until(() => openEntry(m.id, 'merge_decision'));
    expect(second.id).not.toBe(first.id);
    expect((second.payload as { message: string }).message).toBe('Check out main or commit your changes, then choose Merge again');
    expect(mission(m.id).state).toBe('finishing');
    expect(await pending(fin)).toBe(true);

    git(root, 'switch', '-c', 'elsewhere'); // main is now checked out nowhere
    expect(await e.answerMergeDecision(second.id, 'Merge')).toEqual({ outcome: 'merged' });
    expect(await fin).toBe('merge');
    expect(git(root, 'log', '-1', '--format=%s', 'main')).toBe('Maestro: Fix login');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('elsewhere');
    expect(git(root, 'worktree', 'list')).not.toMatch(/merge-|integration/);
  }, T);

  it('records a warning when the conductor uses the built-in Task tool', async () => {
    const e = makeEngine(TASK_HANG, [INIT, USER, ASSISTANT_TASK_TOOL, RATE_LIMITED, ...UNTIL_INTERRUPT]);
    const m = await start(e);
    const warn = await until(() => events.list(db, m.id).find(x => x.type === 'conductor-subagent-warning'));
    expect(warn.data).toMatchObject({ tool: 'Task', count: 1 });
    // The conductor's rate-limit event throttles new starts and updates the usage window.
    await until(() => usageWindow.get(db));
    expect(usageWindow.get(db)!.fiveHour).toEqual({ utilization: 1, resetsAt: 4_000_000_000 });
    expect(e.throttle.throttledUntil(Date.now())).toBe(4_000_000_000_000);
    expect(mission(m.id).conductorSessionId).toBeTruthy();
  }, T);

  it('rejects calls for unknown missions and foreign task ids', async () => {
    const e = makeEngine(TASK_HANG);
    const a = await start(e);
    const b = await start(e);
    expect(b.missionBranch).toBe(`maestro/fix-login-${b.id.replace(/-/g, '').slice(0, 8)}`);
    await expect(e.submitPlan('nope', writePlan(PLAN))).rejects.toThrow(/unknown mission/i);
    await expect(e.waitForTasks('nope', [], 'all', () => {})).rejects.toThrow(/unknown mission/i);
    await expect(e.finishMission('nope', 's')).rejects.toThrow(/unknown mission/i);

    await approved(e, b, PLAN_SRC);
    const rb = await e.dispatchTask(b.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['src/**'] });
    const refB = (rb as { task_ref: string }).task_ref;
    await expect(e.waitForTasks(a.id, [refB], 'all', () => {})).rejects.toThrow(/does not belong|unknown task/i);
    await expect(e.askUser(a.id, refB, { question: 'q' })).rejects.toThrow(/does not belong|unknown task/i);
    await expect(e.waitForTasks(b.id, ['missing'], 'all', () => {})).rejects.toThrow(/unknown task/i);
  }, T);

  it('stop expires mission-level questions', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    const r = await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['src/**'] });
    const ref = (r as { task_ref: string }).task_ref;
    await until(() => tasks.get(db, ref)!.state === 'running');
    const ask = e.askUser(m.id, null, { question: 'Which DB?', options: ['pg', 'sqlite'] });
    const asked = ask.catch((x: unknown) => x);
    const entry = await until(() => openEntry(m.id, 'question'));
    expect(entry.taskId).toBeNull();
    const conductorPid = (db.prepare("SELECT pid FROM sessions WHERE mission_id = ? AND role = 'conductor'").get(m.id) as { pid: number }).pid;

    await e.stop(m.id);
    await e.stop(m.id); // idempotent
    expect(await asked).toBeInstanceOf(Expired);
    expect(inbox.get(db, entry.id)!.state).toBe('expired');
    expect(mission(m.id).state).toBe('stopped');
    expect(tasks.get(db, ref)!.state).toBe('cancelled');
    await until(() => !alive(conductorPid));
    expect(readFileSync(join(dir, 'conductor.jsonl'), 'utf8')).toContain('Make login work.');
  }, T);
});
