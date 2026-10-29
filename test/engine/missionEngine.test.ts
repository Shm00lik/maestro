// MissionEngine integration tests. The conductor is a fake-claude session that just idles (it cannot call MCP
// tools), so each test drives the BridgeHandlers directly, as the conductor would. Task sessions are fake-claude
// scenarios that write a file and end with a `## Handoff`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../../src/store/db.js';
import { events, inbox, missions, projects, sessions, tasks, usageWindow, type InboxEntry, type Mission } from '../../src/store/repos.js';
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
const TASK_SLOW = [INIT, USER, { sleepMs: 1500 }, ...TASK_DONE.slice(2)];
/** Ends with a handoff, then lingers 4 s after stdin closes: the completion is slow. */
const TASK_LINGER = [...TASK_DONE, { sleepMs: 4000 }];
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
  if (engine) { await engine.shutdown(); engine = null; }
  db.close();
  try {
    const wts = git(root, 'worktree', 'list', '--porcelain').split('\n')
      .filter(l => l.startsWith('worktree ')).map(l => l.slice(9).trim()).slice(1);
    for (const w of wts) { try { git(root, 'worktree', 'remove', '--force', w); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function makeEngine(
  taskSteps: object[], conductorSteps: object[] = CONDUCTOR_IDLE, beforeBaseMerge?: () => Promise<void>,
): MissionEngine {
  const taskScenario = join(dir, 'task-scenario.json');
  const condScenario = join(dir, 'conductor-scenario.json');
  writeFileSync(taskScenario, JSON.stringify({ steps: taskSteps }));
  writeFileSync(condScenario, JSON.stringify({ steps: conductorSteps }));
  engine = new MissionEngine({
    db, logDir: join(dir, 'logs'), command, stopTimeoutMs: 1500, progressMs: 100, beforeBaseMerge,
    env: { FAKE_CLAUDE_SCENARIO: taskScenario, FAKE_CLAUDE_LOG: join(dir, 'fake.jsonl') },
    conductorEnv: { FAKE_CLAUDE_SCENARIO: condScenario, FAKE_CLAUDE_LOG: join(dir, 'conductor.jsonl') },
  });
  return engine;
}

const start = (e: MissionEngine, title = 'Fix login', o: { maxParallel?: number; baseBranch?: string; missionBranch?: string } = {}): Promise<Mission> => e.startMission({
  projectId, title, brief: 'Make login work.', depth: 'thorough', baseBranch: o.baseBranch ?? 'main',
  missionBranch: o.missionBranch ?? '', isolation: 'worktree', maxParallel: o.maxParallel ?? 3, quick: true,
});
const ref = (r: { task_ref: string } | { error: string }): string => (r as { task_ref: string }).task_ref;
const versions = (missionId: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM plan_versions WHERE mission_id = ?').get(missionId) as { n: number }).n;

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
  it('stores the auto-allow setting in the mission settings (default on) and keeps it out of the conductor brief', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    expect(mission(m.id).settings).toEqual({ autoAllow: true });
    const off = await e.startMission({
      projectId, title: 'Other', brief: 'b', depth: 'quick', baseBranch: 'main', missionBranch: '',
      isolation: 'worktree', maxParallel: 1, quick: true, autoAllow: false, settings: { note: 'x' },
    });
    expect(mission(off.id).settings).toEqual({ note: 'x', autoAllow: false });
    await until(() => existsSync(join(dir, 'conductor.jsonl')) && readFileSync(join(dir, 'conductor.jsonl'), 'utf8').includes('"type":"user"'));
    const brief = readFileSync(join(dir, 'conductor.jsonl'), 'utf8');
    expect(brief).not.toContain('autoAllow');
  }, T);

  it('the engine option autoAllow: false turns the safe list off for its missions', async () => {
    const taskScenario = join(dir, 'task-scenario.json');
    const condScenario = join(dir, 'conductor-scenario.json');
    writeFileSync(taskScenario, JSON.stringify({ steps: TASK_HANG }));
    writeFileSync(condScenario, JSON.stringify({ steps: CONDUCTOR_IDLE }));
    engine = new MissionEngine({
      db, logDir: join(dir, 'logs'), command, stopTimeoutMs: 1500, autoAllow: false,
      env: { FAKE_CLAUDE_SCENARIO: taskScenario }, conductorEnv: { FAKE_CLAUDE_SCENARIO: condScenario },
    });
    const m = await start(engine);
    expect(mission(m.id).settings).toEqual({ autoAllow: false });
  }, T);

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
    // Nothing is applied until approval (spec §6).
    expect(tasks.listByMission(db, m.id)).toEqual([]);
    expect(versions(m.id)).toBe(0);

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
    expect(versions(m.id)).toBe(0); // created only on approval

    e.replan(m.id, 'Split part A');
    expect(await second).toEqual({ approved: false, note: 'Split part A' });
    expect(await first).toEqual({ approved: false, note: 'Split part A' });
    expect(mission(m.id).state).toBe('planning');
    expect(versions(m.id)).toBe(0);

    // The resubmitted plan becomes version 1; a later, smaller plan becomes version 2 and is applied as a re-plan.
    const third = e.submitPlan(m.id, writePlan(PLAN, 'plan2.md'));
    await until(() => openEntry(m.id, 'plan_approval'));
    e.approvePlan(m.id);
    expect(await third).toEqual({ approved: true });
    const fourth = e.submitPlan(m.id, writePlan(PLAN_SRC, 'plan2b.md'));
    await until(() => openEntry(m.id, 'plan_approval'));
    e.approvePlan(m.id);
    expect(await fourth).toEqual({ approved: true });
    expect(versions(m.id)).toBe(2);
    expect(tasks.listByMission(db, m.id).map(t => [t.taskKey, t.state])).toEqual(
      [['T1', 'planned'], ['T2', 'cancelled'], ['T3', 'cancelled']]);

    // A cancelled key can't be dispatched, and re-introducing it in a plan is an error that leaves no plan version.
    await expect(e.dispatchTask(m.id, { task_id: 'T2', agent: 'implementer', prompt: 'p', depends_on: [], owns: [] }))
      .rejects.toThrow(/T2 is cancelled/);
    const before = versions(m.id);
    const again = await e.submitPlan(m.id, writePlan(PLAN, 'plan3.md'));
    expect('errors' in again && again.errors.map(x => x.message)).toEqual(
      expect.arrayContaining(['T2 conflicts with an existing task; rename it']));
    expect(versions(m.id)).toBe(before);
    expect(mission(m.id).state).toBe('running');
  }, T);

  it('submit_plan with the same path but new content supersedes the pending wait', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    const path = writePlan(PLAN);
    const first = e.submitPlan(m.id, path);
    const firstEntry = await until(() => openEntry(m.id, 'plan_approval'));
    writePlan(PLAN_SRC); // same file, edited
    const second = e.submitPlan(m.id, path);
    expect(await first).toEqual({ approved: false, note: expect.stringMatching(/superseded/i) });
    expect(inbox.get(db, firstEntry.id)!.state).toBe('expired');
    const entry = await until(() => openEntry(m.id, 'plan_approval'));
    expect(entry.id).not.toBe(firstEntry.id);
    expect(versions(m.id)).toBe(0); // neither plan is applied before approval
    e.approvePlan(m.id);
    expect(await second).toEqual({ approved: true });
    expect(versions(m.id)).toBe(1);
    expect(tasks.listByMission(db, m.id).filter(t => t.state === 'planned').map(t => t.taskKey)).toEqual(['T1']);
  }, T);

  it('a re-plan is applied only on approval; a rejected re-plan changes no task rows', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    await approved(e, m, PLAN);
    const r1 = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
    await until(() => tasks.get(db, r1)!.state === 'running');
    const rows = (): string => JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY rowid').all());
    const before = rows();

    const first = e.submitPlan(m.id, writePlan(PLAN_SRC, 'replan.md'));
    const entry = await until(() => openEntry(m.id, 'plan_approval'));
    expect(entry.payload).toMatchObject({ taskKeys: ['T1'], cancelled: ['T2', 'T3'], runningUnplanned: [] });
    expect(rows()).toBe(before); // nothing applied while the approval is pending
    expect(versions(m.id)).toBe(1);
    e.replan(m.id, 'Keep all three');
    expect(await first).toEqual({ approved: false, note: 'Keep all three' });
    expect(rows()).toBe(before); // rejected: no task row changed
    expect(versions(m.id)).toBe(1);

    const second = e.submitPlan(m.id, writePlan(PLAN_SRC, 'replan2.md'));
    await until(() => openEntry(m.id, 'plan_approval'));
    expect(rows()).toBe(before);
    e.approvePlan(m.id);
    expect(await second).toEqual({ approved: true });
    expect(tasks.listByMission(db, m.id).map(t => [t.taskKey, t.state])).toEqual(
      [['T1', 'running'], ['T2', 'cancelled'], ['T3', 'cancelled']]);
    expect(versions(m.id)).toBe(2);
    expect(mission(m.id).state).toBe('running');
  }, T);

  it('a plan key that matches an ad-hoc key ignoring case is a plan error', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    await e.dispatchTask(m.id, { task_id: 't2', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['x/**'] });
    const r = await e.submitPlan(m.id, writePlan(PLAN, 'replan.md'));
    expect('errors' in r && r.errors.map(x => x.message)).toEqual(['T2 conflicts with an existing task; rename it']);
    expect(versions(m.id)).toBe(1);
    expect(mission(m.id).state).toBe('running');
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
    // Done tasks' worktree folders are removed; their branches stay.
    for (const t of tasks.listByMission(db, m.id)) {
      expect(existsSync(t.worktreePath!), t.taskKey).toBe(false);
      expect(git(root, 'branch', '--list', t.branch!)).toContain(t.branch!);
    }
    expect(git(root, 'worktree', 'list')).not.toMatch(/\.claude[\\/]worktrees/);
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
    // The integration worktree is gone, so the user can check the kept branch out.
    expect(git(root, 'worktree', 'list')).not.toMatch(/integration/);
    git(root, 'checkout', 'maestro/fix-login');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('maestro/fix-login');
  }, T);

  it('keeps a done task worktree that has uncommitted changes', async () => {
    const e = makeEngine(TASK_DONE);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    const r = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'Do it.', depends_on: [], owns: ['src/**'] }));
    await e.waitForTasks(m.id, [r], 'all', () => {});
    const t = tasks.listByMission(db, m.id)[0];
    writeFileSync(join(t.worktreePath!, 'scratch.txt'), 'dirty\n');
    const fin = e.finishMission(m.id, 'Done.');
    const entry = await until(() => openEntry(m.id, 'merge_decision'));
    await e.answerMergeDecision(entry.id, 'Merge');
    await fin;
    expect(existsSync(t.worktreePath!)).toBe(true);
    expect(existsSync(join(t.worktreePath!, 'scratch.txt'))).toBe(true);
  }, T);

  it('an untracked file in the main checkout does not block the base merge', async () => {
    const e = makeEngine(TASK_DONE);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    const r = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'Do it.', depends_on: [], owns: ['src/**'] }));
    await e.waitForTasks(m.id, [r], 'all', () => {});
    const fin = e.finishMission(m.id, 'Done.');
    const entry = await until(() => openEntry(m.id, 'merge_decision'));
    writeFileSync(join(root, 'notes-untracked.txt'), 'mine\n');
    expect(await e.answerMergeDecision(entry.id, 'Merge')).toEqual({ outcome: 'merged' });
    expect(await fin).toBe('merge');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // merged in the main checkout itself
    expect(git(root, 'log', '-1', '--format=%s', 'main')).toBe('Maestro: Fix login');
    expect(readFileSync(join(root, 'notes-untracked.txt'), 'utf8')).toBe('mine\n');
    expect(git(root, 'worktree', 'list')).not.toMatch(/merge-/);
  }, T);

  it('asks again when the base branch cannot be merged in place, then merges in a temporary worktree', async () => {
    const e = makeEngine(TASK_DONE);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    const r = await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'Do it.', depends_on: [], owns: ['src/**'] });
    await e.waitForTasks(m.id, [(r as { task_ref: string }).task_ref], 'all', () => {});
    const fin = e.finishMission(m.id, 'Done.');
    const first = await until(() => openEntry(m.id, 'merge_decision'));

    writeFileSync(join(root, 'readme.txt'), 'uncommitted edit\n'); // main is checked out here, with a tracked change
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

  it('a plain-text conductor turn becomes one free-text question whose answer goes back to the conductor', async () => {
    const say = (text: string) => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } } });
    const long = `Which database should I use? ${'x'.repeat(3000)}`;
    const e = makeEngine(TASK_HANG, [
      INIT, USER, say(long), RESULT(long), say('Also: tabs or spaces?'), RESULT('Also: tabs or spaces?'),
      USER, ...UNTIL_INTERRUPT,
    ]);
    const texts: string[] = [];
    e.on('conductor-text', (x: { text: string }) => texts.push(x.text));
    const m = await start(e);
    const q = await until(() => openEntry(m.id, 'question'));
    await sleep(500); // the second plain-text result arrives too
    const open = inbox.listOpen(db, Date.now()).filter(x => x.missionId === m.id && x.kind === 'question');
    expect(open).toHaveLength(1); // never more than one
    expect(q.taskId).toBeNull();
    const p = q.payload as { question: string; options?: string[] };
    expect(p.options).toBeUndefined();
    expect(p.question.startsWith('Which database should I use?')).toBe(true);
    expect(p.question.length).toBeLessThanOrEqual(2000);
    expect(texts[0]).toMatch(/^Which database/);
    e.inbox.answerQuestion(q.id, 'Postgres');
    await until(() => readFileSync(join(dir, 'conductor.jsonl'), 'utf8').includes('Postgres'));
  }, T);

  it('a conductor turn that ends while its own bridge call is pending asks nothing', async () => {
    const e = makeEngine(TASK_HANG, [INIT, USER, { sleepMs: 800 }, RESULT('waiting on you'), USER, ...UNTIL_INTERRUPT]);
    const m = await start(e);
    const asked = e.askUser(m.id, null, { question: 'Pick one', options: ['a', 'b'] }).catch(() => undefined);
    const condLog = join(dir, 'logs', 'missions', m.id, 'conductor.log');
    await until(() => { try { return readFileSync(condLog, 'utf8').includes('"type":"result"'); } catch { return false; } });
    await sleep(300);
    const qs = inbox.listOpen(db, Date.now()).filter(x => x.missionId === m.id && x.kind === 'question');
    expect(qs.map(x => (x.payload as { question: string }).question)).toEqual(['Pick one']);
    void asked;
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

  it('shutdown keeps mission, task and inbox state and leaves no live process', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    const r = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['src/**'] }));
    await until(() => tasks.get(db, r)!.state === 'running');
    const asked = e.askUser(m.id, null, { question: 'Which DB?' }).catch((x: unknown) => x);
    const entry = await until(() => openEntry(m.id, 'question'));
    const waited = e.waitForTasks(m.id, [r], 'all', () => {}).catch((x: unknown) => x);
    const live = await until(() => { const l = sessions.listLive(db); return l.length === 2 && l; });
    expect(live.map(s => s.role).sort()).toEqual(['conductor', 'implementer']);
    const stateEvents = (): number => events.list(db, m.id).filter(x => x.type === 'state').length;
    const stateBefore = stateEvents();

    await e.shutdown();
    await e.shutdown(); // idempotent
    expect(mission(m.id).state).toBe('running');
    expect(tasks.get(db, r)!.state).toBe('running');
    expect(inbox.get(db, entry.id)!.state).toBe('open');
    expect(sessions.listLive(db)).toHaveLength(0);
    for (const s of live) {
      expect((db.prepare('SELECT state FROM sessions WHERE id = ?').get(s.id) as { state: string }).state).toBe('ended');
    }
    await until(() => live.every(s => !alive(s.pid!)));
    expect(await asked).toBeInstanceOf(Error);
    expect(await waited).toBeInstanceOf(Error);
    await sleep(300);
    expect(stateEvents()).toBe(stateBefore);
    expect(mission(m.id).state).toBe('running');
    expect(tasks.get(db, r)!.state).toBe('running');
  }, T);

  it('finish_mission is rejected while dispatched tasks are still active', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    await approved(e, m, PLAN);
    await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] });
    // T2 and T3 stay planned (never dispatched) and do not block.
    await expect(e.finishMission(m.id, 's')).rejects.toThrow('1 tasks are still active: T1; wait for them or stop them first');
    expect(mission(m.id).state).toBe('running');
    expect(openEntry(m.id, 'merge_decision')).toBeUndefined();
  }, T);

  it('a task whose dependency failed is blocked: wait_for_tasks returns it and finish_mission is not held up', async () => {
    const e = makeEngine([INIT, USER, { exit: 1 }]);
    const m = await start(e);
    await approved(e, m, PLAN);
    const r1 = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
    const r3 = ref(await e.dispatchTask(m.id, { task_id: 'T3', agent: 'implementer', prompt: 'p', depends_on: ['T1'], owns: ['c/**'] }));
    const rv = ref(await e.dispatchTask(m.id, { task_id: 'T3-review', agent: 'code-reviewer', prompt: 'p', depends_on: ['T3'], owns: [] }));
    const res = await Promise.race([
      e.waitForTasks(m.id, [r3, rv], 'all', () => {}),
      sleep(12_000).then(() => 'hung' as const),
    ]);
    expect(res).not.toBe('hung');
    const s = res as Awaited<ReturnType<typeof e.waitForTasks>>;
    expect(s.map(x => [x.key, x.status, x.failure_reason])).toEqual([
      ['T3', 'blocked', 'dependency T1 failed'], ['T3-review', 'blocked', 'dependency T3 blocked'],
    ]);
    expect(tasks.get(db, r1)!.state).toBe('failed');
    expect(tasks.get(db, r3)!.state).toBe('waiting'); // blocked is derived, not a state

    const fin = e.finishMission(m.id, 'T1 failed; giving up.');
    const entry = await until(() => openEntry(m.id, 'merge_decision'));
    expect(await e.answerMergeDecision(entry.id, 'Keep branch')).toEqual({ outcome: 'kept' });
    expect(await fin).toBe('keep');
    expect([tasks.get(db, r3)!.state, tasks.get(db, rv)!.state]).toEqual(['cancelled', 'cancelled']);
    expect(tasks.get(db, r1)!.state).toBe('failed');
  }, T);

  it('does not start ready tasks while the mission is not running', async () => {
    const e = makeEngine(TASK_SLOW);
    const m = await start(e, 'Fix login', { maxParallel: 1 });
    await approved(e, m, PLAN);
    const r1 = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
    const r2 = ref(await e.dispatchTask(m.id, { task_id: 'T2', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['b/**'] }));
    await until(() => tasks.get(db, r1)!.state === 'running');
    expect(tasks.get(db, r2)!.state).toBe('ready'); // the mission allows one at a time
    const replan = e.submitPlan(m.id, writePlan(PLAN, 'replan.md'));
    await until(() => openEntry(m.id, 'plan_approval'));
    expect(mission(m.id).state).toBe('awaiting_approval');
    await until(() => tasks.get(db, r1)!.state === 'done');
    await sleep(1500); // at least one scheduler tick
    expect(tasks.get(db, r2)!.state).toBe('ready');
    e.approvePlan(m.id);
    expect(await replan).toEqual({ approved: true });
    await until(() => tasks.get(db, r2)!.state !== 'ready');
    expect(['running', 'done']).toContain(tasks.get(db, r2)!.state);
  }, T);

  it('stop during a slow base merge leaves a consistent state', async () => {
    let entered!: () => void;
    const inMerge = new Promise<void>(r => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const e = makeEngine(TASK_DONE, CONDUCTOR_IDLE, async () => { entered(); await gate; });
    const m = await start(e);
    const base = git(root, 'rev-parse', 'main');
    await approved(e, m, PLAN_SRC);
    const r = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['src/**'] }));
    await e.waitForTasks(m.id, [r], 'all', () => {});
    const fin = e.finishMission(m.id, 'Done.').catch((x: unknown) => x);
    const entry = await until(() => openEntry(m.id, 'merge_decision'));
    const answer = e.answerMergeDecision(entry.id, 'Merge').catch((x: unknown) => x);
    await inMerge;
    const stopped = e.stop(m.id);
    expect(await pending(stopped)).toBe(true); // stop waits for the merge in flight
    release();
    await stopped;
    await answer;
    await fin;
    const after = mission(m.id);
    const baseMerged = git(root, 'rev-parse', 'main') !== base;
    if (baseMerged) expect([after.state, after.outcome]).toEqual(['done', 'merged']);
    else expect(after.state).toBe('stopped');
    expect(after.state === 'stopped' && baseMerged).toBe(false);
    expect(inbox.listOpen(db, Date.now()).filter(x => x.missionId === m.id)).toHaveLength(0);
  }, T);

  it('submit_plan and finish_mission are rejected while the mission is stopping', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    const stopping = e.stop(m.id);
    await expect(e.submitPlan(m.id, writePlan(PLAN))).rejects.toThrow(/stopping/);
    await expect(e.finishMission(m.id, 's')).rejects.toThrow(/stopping/);
    await expect(e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: [] })).rejects.toThrow();
    await stopping;
    expect(versions(m.id)).toBe(0);
  }, T);

  it('startMission validates branch names before creating anything', async () => {
    const e = makeEngine(TASK_HANG);
    const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM missions').get() as { n: number }).n;
    await expect(start(e, 'x', { missionBranch: 'main' })).rejects.toThrow(/same as the base branch/);
    await expect(start(e, 'x', { baseBranch: '-main' })).rejects.toThrow(/invalid base branch/i);
    await expect(start(e, 'x', { missionBranch: '--force' })).rejects.toThrow(/invalid mission branch/i);
    await expect(start(e, 'x', { missionBranch: 'bad..name' })).rejects.toThrow(/invalid mission branch/i);
    await expect(start(e, 'x', { baseBranch: 'nope' })).rejects.toThrow(/does not exist/);
    expect(count()).toBe(0);
    expect(git(root, 'branch', '--list')).not.toMatch(/bad|force/);
  }, T);

  /** Everything the engine could write, to prove nothing changes after a point. */
  const snapshot = (): string => JSON.stringify({
    missions: db.prepare('SELECT * FROM missions ORDER BY id').all(),
    tasks: db.prepare('SELECT id, state, handoff_md, failure_reason FROM tasks ORDER BY id').all(),
    inbox: db.prepare('SELECT id, kind, state, answer_json FROM inbox ORDER BY id').all(),
    events: (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
    plans: db.prepare('SELECT * FROM plan_versions ORDER BY id').all(),
  });

  it('shutdown blocks every bridge handler and mutator while a task completion is slow', async () => {
    const e = makeEngine(TASK_LINGER);
    const m = await start(e);
    await approved(e, m, PLAN);
    const r1 = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
    await until(() => tasks.get(db, r1)!.handoffMd); // completing: the process is lingering
    const inboxBefore = (db.prepare('SELECT COUNT(*) AS n FROM inbox').get() as { n: number }).n;
    const stateEvents = (): number => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'state'").get() as { n: number }).n;
    const statesBefore = stateEvents();

    const sd = e.shutdown();
    const err = /Maestro is shutting down/;
    await expect(e.finishMission(m.id, 's')).rejects.toThrow(err);
    await expect(e.dispatchTask(m.id, { task_id: 'T2', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['b/**'] })).rejects.toThrow(err);
    await expect(e.askUser(m.id, null, { question: 'q' })).rejects.toThrow(err);
    await expect(e.askUser(m.id, r1, { question: 'q' })).rejects.toThrow(err);
    await expect(e.submitPlan(m.id, writePlan(PLAN_SRC, 'late.md'))).rejects.toThrow(err);
    expect(() => e.approvePlan(m.id)).toThrow(err);
    expect(() => e.replan(m.id, 'n')).toThrow(err);
    await expect(e.answerMergeDecision('nope', 'Merge')).rejects.toThrow(err);
    await sd;

    expect(mission(m.id).state).toBe('running');
    expect(tasks.get(db, r1)!.state).toBe('running');
    expect(tasks.getByKey(db, m.id, 'T2')!.state).toBe('planned');
    expect((db.prepare('SELECT COUNT(*) AS n FROM inbox').get() as { n: number }).n).toBe(inboxBefore);
    expect(stateEvents()).toBe(statesBefore);
    expect(git(root, 'log', '--format=%s', 'maestro/fix-login')).not.toMatch(/Merge T1/);
    const snap = snapshot();
    await sleep(500);
    expect(snapshot()).toBe(snap);
  }, T);

  it('shutdown during a slow base merge waits for it and never writes afterwards', async () => {
    let entered!: () => void;
    const inMerge = new Promise<void>(r => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const e = makeEngine(TASK_DONE, CONDUCTOR_IDLE, async () => { entered(); await gate; });
    const m = await start(e);
    const base = git(root, 'rev-parse', 'main');
    await approved(e, m, PLAN_SRC);
    const r = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['src/**'] }));
    await e.waitForTasks(m.id, [r], 'all', () => {});
    void e.finishMission(m.id, 'Done.').catch(() => undefined);
    const entry = await until(() => openEntry(m.id, 'merge_decision'));
    const answer = e.answerMergeDecision(entry.id, 'Merge').catch((x: unknown) => x);
    await inMerge;
    const sd = e.shutdown();
    expect(await pending(sd)).toBe(true); // waits for the merge in flight
    release();
    await sd;
    const res = await answer;
    const after = mission(m.id);
    if (git(root, 'rev-parse', 'main') !== base) {
      expect([after.state, after.outcome]).toEqual(['done', 'merged']);
    } else {
      expect(after.state).toBe('finishing');
      expect(inbox.get(db, entry.id)!.state).toBe('open');
      expect(String(res)).toMatch(/shutting down/);
    }
    const snap = snapshot();
    await sleep(700);
    expect(snapshot()).toBe(snap);
  }, T);

  it('stop after a merged mission leaves its never-dispatched tasks planned', async () => {
    const e = makeEngine(TASK_DONE);
    const m = await start(e);
    await approved(e, m, PLAN);
    const r = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
    await e.waitForTasks(m.id, [r], 'all', () => {});
    const fin = e.finishMission(m.id, 'Partial on purpose.');
    const entry = await until(() => openEntry(m.id, 'merge_decision'));
    await e.answerMergeDecision(entry.id, 'Merge');
    expect(await fin).toBe('merge');
    await e.stop(m.id);
    expect([mission(m.id).state, mission(m.id).outcome]).toEqual(['done', 'merged']);
    expect(tasks.listByMission(db, m.id).map(t => [t.taskKey, t.state])).toEqual(
      [['T1', 'done'], ['T2', 'planned'], ['T3', 'planned']]);
  }, T);

  it('shutdown waits for a stop in progress, so nothing changes after it resolves', async () => {
    const e = makeEngine(TASK_HANG);
    const m = await start(e);
    await approved(e, m, PLAN_SRC);
    const r = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['src/**'] }));
    await until(() => sessions.listLive(db).length === 2);
    const st = e.stop(m.id);
    await e.shutdown();
    expect(mission(m.id).state).toBe('stopped');
    expect(tasks.get(db, r)!.state).toBe('cancelled');
    const snap = snapshot();
    await st;
    await sleep(500);
    expect(snapshot()).toBe(snap);
  }, T);
});
