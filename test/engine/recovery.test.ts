// Restart recovery and stuck detection. Each restart test runs part of a mission on fake-claude with a persisted
// (temp-file) database, shuts the engine down, opens a NEW engine on the same database file, recovers and asserts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../../src/store/db.js';
import { events, inbox, missions, projects, sessions, tasks, type InboxEntry, type Mission } from '../../src/store/repos.js';
import { KEEP, MissionEngine } from '../../src/engine/missionEngine.js';
import { checkStuck } from '../../src/engine/recovery.js';

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
const UNTIL_INTERRUPT = [{ waitFor: 'interrupt', timeoutMs: 120_000 }, ABORTED];
const CONDUCTOR_IDLE = [INIT, USER, ...UNTIL_INTERRUPT];
const TASK_DONE = [INIT, USER, { writeFile: 'out-$SESSION.txt', content: 'work\n' }, RESULT('Did it.\n\n## Handoff\nMade a file.'), { waitFor: 'stdin-close' }];
const TASK_HANG = [INIT, USER, ...UNTIL_INTERRUPT];
/** Never emits init: like a task caught before its Claude session existed. */
const TASK_NO_INIT = [{ sleepMs: 60_000 }];
const CRASH = [{ exit: 1 }];

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
`;

// ---- fixture ---------------------------------------------------------------
let dir: string;
let root: string;
let dbFile: string;
let db: Db;
let engines: MissionEngine[] = [];
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-recovery-'));
  root = mkdtempSync(join(tmpdir(), 'maestro-recovery-repo-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'readme.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  dbFile = join(dir, 'maestro.db');
  db = openDb(dbFile);
  projectId = projects.add(db, { name: 'demo', path: root }).id;
});

afterEach(async () => {
  for (const e of engines) await e.shutdown();
  engines = [];
  db.close();
  try {
    const wts = git(root, 'worktree', 'list', '--porcelain').split('\n')
      .filter(l => l.startsWith('worktree ')).map(l => l.slice(9).trim()).slice(1);
    for (const w of wts) { try { git(root, 'worktree', 'remove', '--force', w); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const taskScenario = (tag: string): string => join(dir, `task-${tag}.json`);
const setTaskSteps = (tag: string, steps: object[]): void =>
  writeFileSync(taskScenario(tag), JSON.stringify({ steps }));

function makeEngine(tag: string, taskSteps: object[], conductorSteps: object[] = CONDUCTOR_IDLE,
  extra: { stuckAfterMs?: number; stuckCheckMs?: number } = {}): MissionEngine {
  const condScenario = join(dir, `conductor-${tag}.json`);
  setTaskSteps(tag, taskSteps);
  writeFileSync(condScenario, JSON.stringify({ steps: conductorSteps }));
  const e = new MissionEngine({
    db, logDir: join(dir, 'logs'), command, stopTimeoutMs: 1500, progressMs: 100, ...extra,
    env: { FAKE_CLAUDE_SCENARIO: taskScenario(tag), FAKE_CLAUDE_LOG: join(dir, `fake-${tag}.jsonl`) },
    conductorEnv: { FAKE_CLAUDE_SCENARIO: condScenario, FAKE_CLAUDE_LOG: join(dir, `conductor-${tag}.jsonl`) },
  });
  engines.push(e);
  return e;
}

/** Shuts the engine down, closes the database and reopens the same file (a Maestro restart). */
async function restart(e: MissionEngine): Promise<void> {
  await e.shutdown();
  engines = engines.filter(x => x !== e);
  db.close();
  db = openDb(dbFile);
}

function argvs(file: string): string[][] {
  let text = '';
  try { text = readFileSync(join(dir, file), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => Array.isArray(l?.argv)).map(l => l.argv);
}
const resumeOf = (argv: string[]): string | undefined => {
  const i = argv.indexOf('--resume');
  return i >= 0 ? argv[i + 1] : undefined;
};

const start = (e: MissionEngine): Promise<Mission> => e.startMission({
  projectId, title: 'Fix login', brief: 'Make login work.', depth: 'thorough', baseBranch: 'main',
  missionBranch: '', isolation: 'worktree', maxParallel: 3, quick: true,
});
const ref = (r: { task_ref: string } | { error: string }): string => (r as { task_ref: string }).task_ref;
const writePlan = (text: string, name = 'plan.md'): string => {
  const p = join(dir, name);
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
const openEntries = (missionId: string, kind: string): InboxEntry[] =>
  (db.prepare("SELECT id FROM inbox WHERE mission_id = ? AND kind = ? AND state = 'open' ORDER BY rowid").all(missionId, kind) as { id: string }[])
    .map(r => inbox.get(db, r.id)!);
const allEntries = (missionId: string, kind: string): InboxEntry[] =>
  (db.prepare('SELECT id FROM inbox WHERE mission_id = ? AND kind = ? ORDER BY rowid').all(missionId, kind) as { id: string }[])
    .map(r => inbox.get(db, r.id)!);
const mission = (id: string): Mission => missions.get(db, id)!;

async function approved(e: MissionEngine, m: Mission, plan: string): Promise<void> {
  const res = e.submitPlan(m.id, writePlan(plan));
  await until(() => openEntries(m.id, 'plan_approval')[0]);
  e.approvePlan(m.id);
  expect(await res).toEqual({ approved: true });
}

/** Mission running with T1 in `running` and a Claude session id (the TASK_HANG scenario). */
async function runningTask(e: MissionEngine): Promise<{ m: Mission; r: string }> {
  const m = await start(e);
  await approved(e, m, PLAN);
  const r = ref(await e.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
  await until(() => { const t = tasks.get(db, r)!; return t.state === 'running' && t.sessionId; });
  await until(() => mission(m.id).conductorSessionId);
  return { m, r };
}

describe('recovery', () => {
  it('resumes running tasks after restart and never re-dispatches done ones', async () => {
    const e1 = makeEngine('1', TASK_DONE);
    const m = await start(e1);
    await approved(e1, m, PLAN);
    const r1 = ref(await e1.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
    await until(() => tasks.get(db, r1)!.state === 'done');
    setTaskSteps('1', TASK_HANG);
    const r2 = ref(await e1.dispatchTask(m.id, { task_id: 'T2', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['b/**'] }));
    const s2 = await until(() => { const t = tasks.get(db, r2)!; return t.state === 'running' && t.sessionId; });
    const conductorSession = await until(() => mission(m.id).conductorSessionId);
    await restart(e1);

    const e2 = makeEngine('2', TASK_DONE);
    const rep = await e2.recover(() => false);
    expect(rep.resumed).toEqual([r2]);
    expect(rep.failed).toEqual([]);
    await until(() => tasks.get(db, r2)!.state === 'done');
    expect(tasks.get(db, r1)!.state).toBe('done');
    const taskArgv = argvs('fake-2.jsonl');
    expect(taskArgv).toHaveLength(1); // T2's resume only: T1 never runs again
    expect(resumeOf(taskArgv[0])).toBe(s2);
    const condArgv = argvs('conductor-2.jsonl');
    expect(condArgv).toHaveLength(1);
    expect(resumeOf(condArgv[0])).toBe(conductorSession);
    expect(readFileSync(join(dir, 'conductor-2.jsonl'), 'utf8')).toContain('Maestro restarted');
    expect(mission(m.id).state).toBe('running');
    expect(sessions.listLive(db).map(s => s.role)).toEqual(['conductor']);
  }, T);

  it("marks tasks failed with reason 'unrecoverable' when --resume fails", async () => {
    const e1 = makeEngine('1', TASK_HANG);
    const { m, r } = await runningTask(e1);
    await restart(e1);

    const e2 = makeEngine('2', CRASH);
    const rep = await e2.recover(() => false);
    expect(rep.resumed).toEqual([]);
    expect(rep.failed).toEqual([{ taskId: r, reason: 'unrecoverable' }]);
    const t = tasks.get(db, r)!;
    expect(t.state).toBe('failed');
    expect(t.failureReason).toBe('unrecoverable');
    await sleep(500);
    expect(argvs('fake-2.jsonl')).toHaveLength(1); // one resume attempt, no retry
    expect(mission(m.id).state).toBe('running');
  }, T);

  it('resumes the conductor once, then fails the mission', async () => {
    const e1 = makeEngine('1', TASK_HANG);
    const { m, r } = await runningTask(e1);
    const wt = tasks.get(db, r)!.worktreePath!;
    await restart(e1);

    const e2 = makeEngine('2', TASK_DONE, CRASH);
    await e2.recover(() => false);
    await until(() => mission(m.id).state === 'failed');
    const failedEv = events.list(db, m.id).find(x => x.type === 'mission-failed');
    expect(failedEv?.data).toMatchObject({ reason: 'conductor-unrecoverable' });
    await sleep(1000);
    const condArgv = argvs('conductor-2.jsonl');
    expect(condArgv).toHaveLength(1); // resumed once, never again
    expect(resumeOf(condArgv[0])).toBeTruthy();
    expect(argvs('fake-2.jsonl')).toHaveLength(0); // the mission's tasks are not resumed
    expect(existsSync(wt)).toBe(true); // worktree kept
    expect(git(root, 'branch', '--list', 'maestro/fix-login--T1')).toMatch(/T1/);
    expect(sessions.listLive(db)).toHaveLength(0);
  }, T);

  it('a conductor that crashes while running is resumed once, then a second crash fails the mission', async () => {
    const e = makeEngine('1', TASK_HANG, [INIT, USER, { exit: 1 }]);
    const m = await start(e);
    await until(() => mission(m.id).state === 'failed');
    const condArgv = argvs('conductor-1.jsonl');
    expect(condArgv).toHaveLength(2);
    expect(resumeOf(condArgv[0])).toBeUndefined();
    expect(resumeOf(condArgv[1])).toBe(mission(m.id).conductorSessionId);
    expect(events.list(db, m.id).find(x => x.type === 'mission-failed')?.data).toEqual({ reason: 'conductor-unrecoverable' });
    expect(events.list(db, m.id).filter(x => x.type === 'conductor-exited')).toHaveLength(2);
  }, T);

  it('flags tasks with no events for 20 minutes once', async () => {
    const e = makeEngine('1', TASK_HANG);
    const { m, r } = await runningTask(e);
    expect(checkStuck(db, Date.now())).toEqual([]);
    const later = Date.now() + 21 * 60_000;
    expect(checkStuck(db, later)).toEqual([r]);
    expect(checkStuck(db, later, 30 * 60_000)).toEqual([]);
    e.checkStuckTasks(later);
    e.checkStuckTasks(later);
    const qs = openEntries(m.id, 'question');
    expect(qs).toHaveLength(1);
    expect(qs[0].taskId).toBe(r);
    expect(qs[0].payload).toEqual({
      question: expect.stringMatching(/^T1 seems stuck — no activity for 2\d minutes$/),
      options: ['Stop task', 'Keep waiting'],
    });
    await until(() => tasks.get(db, r)!.state === 'needs_you');
    e.checkStuckTasks(later);
    expect(allEntries(m.id, 'question')).toHaveLength(1);
  }, T);

  it('restarts a task that had no session id', async () => {
    const e1 = makeEngine('1', TASK_NO_INIT);
    const m = await start(e1);
    await approved(e1, m, PLAN);
    const r = ref(await e1.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
    await until(() => sessions.listLive(db).some(s => s.taskId === r));
    expect(tasks.get(db, r)!.sessionId).toBeNull();
    await until(() => mission(m.id).conductorSessionId);
    await restart(e1);

    const e2 = makeEngine('2', TASK_DONE);
    const rep = await e2.recover(() => false);
    expect(rep.restarted).toEqual([r]);
    expect(rep.resumed).toEqual([]);
    await until(() => tasks.get(db, r)!.state === 'done');
    const taskArgv = argvs('fake-2.jsonl');
    expect(taskArgv).toHaveLength(1);
    expect(resumeOf(taskArgv[0])).toBeUndefined();
    expect(events.list(db, m.id, { taskId: r }).some(x => x.type === 'state' && x.data.event === 'recover')).toBe(true);
  }, T);

  it('does not touch tasks whose live session pid is alive', async () => {
    const e1 = makeEngine('1', TASK_HANG);
    const { m, r } = await runningTask(e1);
    await restart(e1);
    const other = sessions.start(db, { missionId: m.id, taskId: r, role: 'implementer', pid: 424242, logPath: 'x.log' });

    const e2 = makeEngine('2', TASK_DONE);
    const rep = await e2.recover(pid => pid === 424242);
    expect(rep.skipped).toEqual([r]);
    expect(rep.resumed).toEqual([]);
    await sleep(1200); // a scheduler tick
    expect(tasks.get(db, r)!.state).toBe('running');
    expect(argvs('fake-2.jsonl')).toHaveLength(0);
    expect(sessions.listLive(db).some(s => s.id === other.id)).toBe(true);
  }, T);

  it('stuck entry is created once and Keep waiting snoozes it', async () => {
    const e = makeEngine('1', TASK_HANG, CONDUCTOR_IDLE, { stuckAfterMs: 1000, stuckCheckMs: 100 });
    const { m, r } = await runningTask(e);
    const first = await until(() => openEntries(m.id, 'question')[0]);
    expect(first.taskId).toBe(r);
    await sleep(1500);
    expect(allEntries(m.id, 'question')).toHaveLength(1);
    e.inbox.answerQuestion(first.id, 'Keep waiting');
    await until(() => tasks.get(db, r)!.state === 'running');
    await sleep(500);
    expect(allEntries(m.id, 'question')).toHaveLength(1); // snoozed
    const second = await until(() => openEntries(m.id, 'question')[0]);
    expect(second.id).not.toBe(first.id);
    e.inbox.answerQuestion(second.id, 'Stop task');
    await until(() => tasks.get(db, r)!.state === 'cancelled');
  }, T);

  it('stop after shutdown is rejected', async () => {
    const e = makeEngine('1', TASK_HANG);
    const m = await start(e);
    await e.shutdown();
    const state = mission(m.id).state;
    await expect(e.stop(m.id)).rejects.toThrow('Maestro is shutting down');
    await expect(e.stopAll()).rejects.toThrow('Maestro is shutting down');
    await sleep(200);
    expect(mission(m.id).state).toBe(state);
  }, T);

  it('re-attaches a pending plan approval and expires old conductor questions', async () => {
    const e1 = makeEngine('1', TASK_HANG);
    const m = await start(e1);
    const planPath = writePlan(PLAN);
    void e1.submitPlan(m.id, planPath).catch(() => undefined);
    const approval = await until(() => openEntries(m.id, 'plan_approval')[0]);
    void e1.askUser(m.id, null, { question: 'Which DB?' }).catch(() => undefined);
    const q = await until(() => openEntries(m.id, 'question')[0]);
    await until(() => mission(m.id).conductorSessionId);
    await restart(e1);

    const e2 = makeEngine('2', TASK_HANG);
    await e2.recover(() => false);
    expect(inbox.get(db, approval.id)!.state).toBe('open');
    expect(inbox.get(db, q.id)!.state).toBe('expired');
    const again = e2.submitPlan(m.id, planPath); // the resumed conductor re-calls with the same plan
    await sleep(100);
    e2.approvePlan(m.id);
    expect(await again).toEqual({ approved: true });
    expect(inbox.get(db, approval.id)!.state).toBe('answered');
    expect(mission(m.id).state).toBe('running');
    expect((db.prepare('SELECT COUNT(*) AS n FROM plan_versions WHERE mission_id = ?').get(m.id) as { n: number }).n).toBe(1);
  }, T);

  it('re-attaches a pending merge decision', async () => {
    const e1 = makeEngine('1', TASK_DONE);
    const m = await start(e1);
    await approved(e1, m, PLAN);
    const r = ref(await e1.dispatchTask(m.id, { task_id: 'T1', agent: 'implementer', prompt: 'p', depends_on: [], owns: ['a/**'] }));
    await until(() => tasks.get(db, r)!.state === 'done');
    void e1.finishMission(m.id, 'All done.').catch(() => undefined);
    const entry = await until(() => openEntries(m.id, 'merge_decision')[0]);
    await until(() => mission(m.id).conductorSessionId);
    await restart(e1);

    const e2 = makeEngine('2', TASK_DONE);
    await e2.recover(() => false);
    expect(mission(m.id).state).toBe('finishing');
    const again = e2.finishMission(m.id, 'All done.');
    expect(await e2.answerMergeDecision(entry.id, KEEP)).toEqual({ outcome: 'kept' });
    expect(await again).toBe('keep');
    expect(mission(m.id).state).toBe('done');
    expect(argvs('fake-2.jsonl')).toHaveLength(0);
  }, T);
});
