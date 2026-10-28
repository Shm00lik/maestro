import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../../src/store/db.js';
import { events, inbox, missions, planVersions, projects, sessions, tasks, type Task } from '../../src/store/repos.js';
import { buildGraph } from '../../src/core/plan/graph.js';
import { InboxService } from '../../src/engine/inbox.js';
import { killTree } from '../../src/claude/processTree.js';
import { createTaskWorktree, worktreeDirFor } from '../../src/git/worktrees.js';
import { AGENT_ROLES } from '../../src/core/types.js';
import {
  LiveSessionRegistry, TaskRunner, buildTaskArgs, loadRole, type TaskFinished,
} from '../../src/engine/taskRunner.js';

const FAKE = fileURLToPath(new URL('../fake-claude/fake-claude.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const command = { exe: process.execPath, prefixArgs: ['--import', TSX, FAKE] };
const MISSION_BRANCH = 'maestro/fix-login';
const TASK_BRANCH = 'maestro/fix-login--T1';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();

// ---- scenario steps --------------------------------------------------------
const INIT = (tools = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']) =>
  ({ emit: { type: 'system', subtype: 'init', model: 'm', cwd: 'c', tools, permissionMode: 'acceptEdits' } });
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
const RESULT = (text: string) => ({
  emit: { type: 'result', subtype: 'success', is_error: false, result: text, session_id: '$SESSION', usage: USAGE },
  templated: true,
});
const ABORTED = {
  emit: { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', session_id: '$SESSION', usage: USAGE },
  templated: true,
};
const PERM = (id: string, cmd: string) => ({
  emit: { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: cmd }, tool_use_id: `tu-${id}` } },
});
const USER = { waitFor: 'user' };
const STDIN_CLOSE = { waitFor: 'stdin-close' };
const HANDOFF = 'All done.\n\n## Handoff\nMade x.';

// ---- fixture ---------------------------------------------------------------
let dir: string;
let root: string;
let ctx: Ctx | null = null;

interface Ctx {
  db: Db; runner: TaskRunner; inboxSvc: InboxService; registry: LiveSessionRegistry; task: Task; missionId: string;
  states: string[]; finished: TaskFinished[];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-runner-'));
  root = mkdtempSync(join(tmpdir(), 'maestro-runner-repo-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  git(root, 'branch', MISSION_BRANCH, 'main');
});

afterEach(async () => {
  if (ctx) {
    await ctx.runner.stop(ctx.task.id).catch(() => undefined);
    ctx.runner.dispose();
    ctx.db.close();
    ctx = null;
  }
  for (const l of fakeLogLines()) if (typeof l.spawnedChild === 'number') killTree(l.spawnedChild);
  try {
    const wts = git(root, 'worktree', 'list', '--porcelain').split('\n')
      .filter(l => l.startsWith('worktree ')).map(l => l.slice(9).trim()).slice(1);
    for (const w of wts) { try { git(root, 'worktree', 'remove', '--force', w); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const fakeLog = (): string => join(dir, 'fake.jsonl');
function fakeLogLines(): any[] {
  try { return readFileSync(fakeLog(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}
const argvs = (): string[][] => fakeLogLines().filter(l => Array.isArray(l.argv)).map(l => l.argv as string[]);
const userTexts = (): string[] => fakeLogLines().filter(l => l?.type === 'user').map(l => l.message.content as string);

function setup(steps: object[], agent = 'implementer'): Ctx {
  const db = openDb(':memory:');
  const p = projects.add(db, { name: 'demo', path: root });
  const m = missions.create(db, {
    projectId: p.id, title: 'M', brief: 'b', depth: 'thorough', baseBranch: 'main',
    missionBranch: MISSION_BRANCH, isolation: 'worktree', maxParallel: 3,
  });
  const pv = planVersions.create(db, { missionId: m.id, version: 1, planPath: 'p', planMd: '#' });
  const pt = { key: 'T1', title: 'Fix', body: 'Do the thing.', dependsOn: [], agent, owns: ['src/**'], acceptance: 'Tests pass.', estimate: 1 };
  const [t] = tasks.insertPlan(db, m.id, pv.id, [pt], buildGraph([pt]));
  tasks.transition(db, t.id, 'dispatch');
  const task = tasks.transition(db, t.id, 'deps_met');
  const scenario = join(dir, 'scenario.json');
  writeFileSync(scenario, JSON.stringify({ steps }));
  const registry = new LiveSessionRegistry();
  const inboxSvc = new InboxService(db, registry);
  const runner = new TaskRunner({
    db, inbox: inboxSvc, registry, projectRoot: root, missionBranch: MISSION_BRANCH,
    bridgeAskConfig: id => join(dir, `bridge-${id}.json`), logDir: join(dir, 'logs'), command,
    env: { FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_LOG: fakeLog() }, stopTimeoutMs: 2000,
  });
  const c: Ctx = { db, runner, inboxSvc, registry, task, missionId: m.id, states: [], finished: [] };
  runner.on('state', (x: Task) => c.states.push(x.state));
  runner.on('finished', (f: TaskFinished) => c.finished.push(f));
  ctx = c;
  return c;
}

const finished = (c: Ctx, nth = 1): Promise<TaskFinished> => new Promise(res => {
  if (c.finished.length >= nth) { res(c.finished[nth - 1]); return; }
  const f = (): void => { if (c.finished.length >= nth) { c.runner.off('finished', f); res(c.finished[nth - 1]); } };
  c.runner.on('finished', f);
});
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const writeScenario = (steps: object[]): void => writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps }));
const waitState = (c: Ctx, state: string, nth = 1): Promise<void> => new Promise(res => {
  const check = (): boolean => c.states.filter(s => s === state).length >= nth;
  if (check()) { res(); return; }
  const f = (): void => { if (check()) { c.runner.off('state', f); res(); } };
  c.runner.on('state', f);
});
const getTask = (c: Ctx): Task => tasks.get(c.db, c.task.id)!;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('roles', () => {
  it('loads all 9 role files with models per the role table', () => {
    const models: Record<string, string> = {
      researcher: 'haiku', architect: 'opus', designer: 'opus', implementer: 'sonnet', 'test-author': 'sonnet',
      debugger: 'opus', 'spec-reviewer': 'sonnet', 'code-reviewer': 'opus', qa: 'sonnet',
    };
    for (const name of AGENT_ROLES) {
      const r = loadRole(name);
      expect(r.name).toBe(name);
      expect(r.model).toBe(models[name]);
      expect(r.body).toContain('## Handoff');
    }
    for (const name of ['researcher', 'spec-reviewer', 'code-reviewer'] as const) expect(loadRole(name).tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(loadRole('implementer').tools).toBeUndefined();
    expect(loadRole('implementer').body).toContain('superpowers:test-driven-development');
  });

  it('parses front matter from a custom dir', () => {
    writeFileSync(join(dir, 'qa.md'), '---\nname: qa\nmodel: haiku\ndenied_tools: [WebFetch, WebSearch]\n---\nCheck it.\n## Handoff\n');
    const r = loadRole('qa', dir);
    expect(r).toEqual({ name: 'qa', model: 'haiku', deniedTools: ['WebFetch', 'WebSearch'], body: 'Check it.\n## Handoff' });
    writeFileSync(join(dir, 'qa.md'), '---\nname: qa\nmodel: gpt\n---\nx');
    expect(() => loadRole('qa', dir)).toThrow(/model/);
  });

  it('read-only roles get --tools Read,Glob,Grep and --strict-mcp-config', () => {
    const args = buildTaskArgs(loadRole('code-reviewer'), 'sys.md', 'bridge.json');
    expect(args.join(' ')).toContain('--tools Read,Glob,Grep');
    expect(args).toContain('--strict-mcp-config');
    expect(args.join(' ')).toContain('--mcp-config bridge.json');
    expect(args.join(' ')).toContain('--permission-mode acceptEdits');
    expect(args.join(' ')).toContain('--model opus');
    expect(args.join(' ')).toContain('--append-system-prompt-file sys.md');
    expect(args).not.toContain('--resume');
    const impl = buildTaskArgs(loadRole('implementer'), 'sys.md', 'bridge.json', 'S9');
    expect(impl).not.toContain('--tools');
    expect(impl).toContain('--strict-mcp-config');
    expect(impl.join(' ')).toContain('--resume S9');
    const denied = buildTaskArgs({ name: 'qa', model: 'sonnet', deniedTools: ['WebFetch'], body: '' }, 's', 'b');
    expect(denied.join(' ')).toContain('--disallowedTools WebFetch');
  });
});

describe('TaskRunner', () => {
  it('runs to done, stores handoff, usage and merge commit', async () => {
    const c = setup([INIT(), USER, USER, RESULT(HANDOFF), STDIN_CLOSE]);
    await c.runner.start(c.task.id, [{ key: 'T0', handoff: 'Upstream made y.' }]);
    const t0 = getTask(c);
    expect(t0.state).toBe('running');
    expect(t0.branch).toBe(TASK_BRANCH);
    expect(t0.worktreePath).toBe(worktreeDirFor(root, c.missionId, 'T1'));
    // The "agent" commits a file, and leaves another uncommitted (the runner commits leftovers).
    writeFileSync(join(t0.worktreePath!, 'b.txt'), 'made by agent\n');
    git(t0.worktreePath!, 'add', '.');
    git(t0.worktreePath!, 'commit', '-m', 'agent work');
    writeFileSync(join(t0.worktreePath!, 'c.txt'), 'left over\n');
    c.runner.message(c.task.id, 'go');
    const f = await finished(c);
    expect(f).toEqual({ taskId: c.task.id, outcome: 'done' });
    const t = getTask(c);
    expect(t.state).toBe('done');
    expect(t.handoffMd).toBe('Made x.');
    expect(t.sessionId).toBeTruthy();
    expect([t.tokensIn, t.tokensOut, t.tokensCacheRead, t.tokensCacheWrite]).toEqual([10, 20, 30, 40]);
    const merged = events.list(c.db, c.missionId, { taskId: c.task.id }).find(e => e.type === 'merged');
    expect(merged?.data.commit).toBe(git(root, 'rev-parse', MISSION_BRANCH));
    expect(git(root, 'show', `${MISSION_BRANCH}:b.txt`)).toBe('made by agent');
    expect(git(root, 'show', `${MISSION_BRANCH}:c.txt`)).toBe('left over');
    expect(git(root, 'log', '-1', '--format=%s', TASK_BRANCH)).toBe('maestro: uncommitted changes from T1');
    expect(c.states).toEqual(['running', 'done']);
    const prompt = userTexts()[0];
    expect(prompt).toContain('Do the thing.');
    expect(prompt).toContain('### T0 handoff\nUpstream made y.');
    expect(prompt).toContain('Tests pass.');
    expect(prompt).toContain('## Handoff');
    expect(sessions.listLive(c.db)).toHaveLength(0);
    expect(c.registry.size).toBe(0);
    const argv = argvs()[0];
    expect(argv.join(' ')).toContain('--model sonnet');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv.join(' ')).toContain(`--mcp-config ${join(dir, `bridge-${c.task.id}.json`)}`);
  }, 15000);

  it('sends one handoff reminder then fails with no-handoff', async () => {
    const c = setup([INIT(), USER, RESULT('I did stuff.'), USER, RESULT('Still no section.'), STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    const f = await finished(c);
    expect(f).toEqual({ taskId: c.task.id, outcome: 'failed', reason: 'no-handoff' });
    expect(getTask(c).state).toBe('failed');
    expect(getTask(c).failureReason).toBe('no-handoff');
    expect(userTexts().slice(1)).toEqual(['Finish with a ## Handoff section.']);
    expect(getTask(c).tokensIn).toBe(20);
  }, 15000);

  it('resumeAfterCrash starts a new process with --resume <sessionId>', async () => {
    const c = setup([INIT(), USER, RESULT(HANDOFF), STDIN_CLOSE]);
    tasks.transition(c.db, c.task.id, 'start');
    const wt = worktreeDirFor(root, c.missionId, 'T1');
    await createTaskWorktree(root, MISSION_BRANCH, TASK_BRANCH, wt);
    tasks.setRuntime(c.db, c.task.id, { sessionId: 'S-old', worktreePath: wt, branch: TASK_BRANCH });
    await c.runner.resumeAfterCrash(c.task.id);
    const f = await finished(c);
    expect(f.outcome).toBe('done');
    const argv = argvs()[0];
    expect(argv[argv.indexOf('--resume') + 1]).toBe('S-old');
    expect(getTask(c).sessionId).toBe('S-old');
  }, 15000);

  it('read-only role whose init lists Edit fails with unsafe-tools', async () => {
    const c = setup([INIT(['Read', 'Glob', 'Grep', 'Edit']), STDIN_CLOSE], 'code-reviewer');
    await c.runner.start(c.task.id, []);
    const f = await finished(c);
    expect(f.outcome).toBe('failed');
    expect(f.reason).toMatch(/^unsafe-tools: Edit/);
    expect(getTask(c).state).toBe('failed');
    expect(argvs()[0].join(' ')).toContain('--tools Read,Glob,Grep');
    expect(sessions.listLive(c.db)).toHaveLength(0);
  }, 15000);

  it('any foreign MCP tool fails the task with unsafe-tools', async () => {
    const c = setup([INIT(['Read', 'Bash', 'mcp__maestro__ask', 'mcp__slack__post']), STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    const f = await finished(c);
    expect(f.reason).toBe('unsafe-tools: mcp__slack__post');
  }, 15000);

  it('opening a permission entry moves the task to needs_you and answering it returns it to running', async () => {
    const c = setup([INIT(), USER, PERM('r1', 'npm test'), { waitFor: 'permission-answer' }, RESULT(HANDOFF), STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    await waitState(c, 'needs_you');
    const [e] = inbox.listOpen(c.db, Date.now());
    expect(e.taskId).toBe(c.task.id);
    expect(c.inboxSvc.answerPermission(e.id, { allow: true }).delivered).toBe(true);
    expect(getTask(c).state).toBe('running');
    const f = await finished(c);
    expect(f.outcome).toBe('done');
    expect(c.states).toEqual(['running', 'needs_you', 'running', 'done']);
  }, 15000);

  it('two open entries need two answers before running', async () => {
    const c = setup([
      INIT(), USER, PERM('r1', 'npm test'), PERM('r2', 'npm run lint'),
      { waitFor: 'permission-answer' }, { waitFor: 'permission-answer' }, RESULT(HANDOFF), STDIN_CLOSE,
    ]);
    await c.runner.start(c.task.id, []);
    await waitState(c, 'needs_you');
    while (inbox.openCountForTask(c.db, c.task.id) < 2) await sleep(20);
    const [e1, e2] = inbox.listOpen(c.db, Date.now());
    c.inboxSvc.answerPermission(e1.id, { allow: true });
    expect(getTask(c).state).toBe('needs_you');
    c.inboxSvc.answerPermission(e2.id, { allow: false, message: 'no' });
    expect(getTask(c).state).toBe('running');
    expect((await finished(c)).outcome).toBe('done');
  }, 15000);

  it('detachAll kills the process without changing task state or expiring its inbox entries', async () => {
    const c = setup([INIT(), USER, PERM('r1', 'npm test'), { waitFor: 'permission-answer', timeoutMs: 60_000 }, RESULT(HANDOFF), STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    await waitState(c, 'needs_you');
    const [row] = sessions.listLive(c.db);
    expect(alive(row.pid!)).toBe(true);
    await c.runner.detachAll();
    await c.runner.detachAll(); // idempotent
    expect(getTask(c).state).toBe('needs_you');
    expect(inbox.openCountForTask(c.db, c.task.id)).toBe(1);
    expect(sessions.listLive(c.db)).toHaveLength(0);
    expect((c.db.prepare('SELECT state FROM sessions WHERE id = ?').get(row.id) as { state: string }).state).toBe('ended');
    expect(c.registry.size).toBe(0);
    for (let i = 0; i < 50 && alive(row.pid!); i++) await sleep(50);
    expect(alive(row.pid!)).toBe(false);
    await sleep(200);
    expect(c.finished).toEqual([]);
    expect(getTask(c).failureReason).toBeNull();
  }, 15000);

  it('stop is idempotent and expires pending permissions', async () => {
    const c = setup([
      INIT(), USER, PERM('r1', 'npm test'), PERM('r2', 'npm run lint'), { waitFor: 'interrupt' },
      { emit: { type: 'control_cancel_request', request_id: 'r1' } }, ABORTED, STDIN_CLOSE,
    ]);
    await c.runner.start(c.task.id, []);
    await waitState(c, 'needs_you');
    while (inbox.openCountForTask(c.db, c.task.id) < 2) await sleep(20);
    const [a, b] = await Promise.all([c.runner.stop(c.task.id), c.runner.stop(c.task.id)]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    await c.runner.stop(c.task.id);
    expect(getTask(c).state).toBe('cancelled');
    expect(inbox.openCountForTask(c.db, c.task.id)).toBe(0);
    expect(c.finished).toEqual([{ taskId: c.task.id, outcome: 'cancelled' }]);
    expect(sessions.listLive(c.db)).toHaveLength(0);
    // The interrupt's result is not treated as a failure; no control_response was written for the cancelled request.
    expect(fakeLogLines().filter(l => l?.type === 'control_response')).toHaveLength(0);
    expect(getTask(c).failureReason).toBeNull();
  }, 15000);

  it('process crash marks the task failed with the last 50 log lines', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ emit: { type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] } } }));
    const c = setup([INIT(), USER, ...lines, { exit: 1 }]);
    await c.runner.start(c.task.id, []);
    const f = await finished(c);
    expect(f.outcome).toBe('failed');
    const reason = getTask(c).failureReason!;
    expect(reason).toMatch(/^crashed/);
    expect(reason).toContain('"line 59"');
    expect(reason).not.toContain('"line 9"');
    expect(reason.length).toBeLessThanOrEqual(4200);
    expect(f.reason).toBe(reason);
  }, 15000);

  it('merge conflict fails the task with reason conflict', async () => {
    const c = setup([INIT(), USER, USER, RESULT(HANDOFF), STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    const wt = getTask(c).worktreePath!;
    writeFileSync(join(wt, 'a.txt'), 'task change\n');
    git(wt, 'commit', '-am', 'task');
    // Move the mission branch on with a conflicting change (via a scratch worktree).
    const other = join(dir, 'other');
    git(root, 'worktree', 'add', other, MISSION_BRANCH);
    writeFileSync(join(other, 'a.txt'), 'mission change\n');
    git(other, 'commit', '-am', 'mission');
    git(root, 'worktree', 'remove', '--force', other);
    c.runner.message(c.task.id, 'go');
    const f = await finished(c);
    expect(f).toEqual({ taskId: c.task.id, outcome: 'failed', reason: 'conflict: a.txt' });
    expect(getTask(c).failureReason).toBe('conflict: a.txt');
    expect(getTask(c).handoffMd).toBe('Made x.');
  }, 15000);

  it('a failed result fails the task with its subtype', async () => {
    const c = setup([INIT(), USER, { emit: { ...ABORTED.emit, subtype: 'error_max_turns' }, templated: true }, STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    expect(await finished(c)).toEqual({ taskId: c.task.id, outcome: 'failed', reason: 'error_max_turns' });
  }, 15000);

  it('stop on a task that never started cancels it', async () => {
    const c = setup([STDIN_CLOSE]);
    await c.runner.stop(c.task.id);
    expect(getTask(c).state).toBe('cancelled');
    expect(existsSync(worktreeDirFor(root, c.missionId, 'T1'))).toBe(false);
  });
  it('a read-only role is an allow-list: any extra built-in fails with unsafe-tools', async () => {
    const c = setup([INIT(['Read', 'Glob', 'Grep', 'MultiEdit', 'Task', 'mcp__maestro__ask_user']), STDIN_CLOSE], 'spec-reviewer');
    await c.runner.start(c.task.id, []);
    expect((await finished(c)).reason).toBe('unsafe-tools: MultiEdit,Task');
  }, 15000);

  it('retry after the worktree folder was removed reuses the existing branch', async () => {
    const c = setup([INIT(), USER, USER, { exit: 1 }]);
    await c.runner.start(c.task.id, []);
    const wt = getTask(c).worktreePath!;
    writeFileSync(join(wt, 'b.txt'), 'first attempt\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'attempt 1');
    c.runner.message(c.task.id, 'go');
    expect((await finished(c)).reason).toMatch(/^crashed/);
    rmSync(wt, { recursive: true, force: true });
    tasks.transition(c.db, c.task.id, 'retry');
    tasks.transition(c.db, c.task.id, 'deps_met');
    writeScenario([INIT(), USER, RESULT(HANDOFF), STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    expect((await finished(c, 2)).outcome).toBe('done');
    expect(getTask(c).branch).toBe(TASK_BRANCH);
    expect(git(root, 'show', `${MISSION_BRANCH}:b.txt`)).toBe('first attempt');
  }, 15000);

  it('moves aside (never deletes) a worktree folder that is not a registered worktree', async () => {
    const c = setup([INIT(), USER, RESULT(HANDOFF), STDIN_CLOSE]);
    const wt = worktreeDirFor(root, c.missionId, 'T1');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'junk.txt'), 'junk');
    await c.runner.start(c.task.id, []);
    expect(existsSync(join(wt, 'junk.txt'))).toBe(false);
    const stale = readdirSync(dirname(wt)).filter(n => n.startsWith(`${basename(wt)}.stale-`));
    expect(stale).toHaveLength(1);
    expect(readFileSync(join(dirname(wt), stale[0], 'junk.txt'), 'utf8')).toBe('junk');
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(TASK_BRANCH);
    expect((await finished(c)).outcome).toBe('done');
  }, 15000);

  it('stop during an in-progress fail waits until the process is dead', async () => {
    const c = setup([INIT(['Read', 'Glob', 'Grep', 'Edit']), STDIN_CLOSE], 'code-reviewer');
    let stopped: Promise<void> | null = null;
    c.runner.on('state', (t: Task) => { if (t.state === 'failed') stopped = c.runner.stop(c.task.id); });
    await c.runner.start(c.task.id, []);
    while (!stopped) await sleep(20);
    await stopped;
    const { pid } = c.db.prepare('SELECT pid FROM sessions WHERE task_id = ?').get(c.task.id) as { pid: number };
    expect(alive(pid)).toBe(false);
    expect(c.finished).toHaveLength(1);
    expect(c.finished[0].outcome).toBe('failed');
    expect(getTask(c).state).toBe('failed');
  }, 15000);

  it('a throwing state listener on done still gives exactly one finished and no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const c = setup([INIT(), USER, RESULT(HANDOFF), STDIN_CLOSE]);
      c.runner.on('state', (t: Task) => { if (t.state === 'done') throw new Error('listener boom'); });
      await c.runner.start(c.task.id, []);
      expect(await finished(c)).toEqual({ taskId: c.task.id, outcome: 'done' });
      await sleep(300);
      expect(c.finished).toHaveLength(1);
      expect(getTask(c).state).toBe('done');
      expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', onUnhandled); }
  }, 15000);

  it('a throwing state listener on running fails the task exactly once', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const c = setup([INIT(), USER, RESULT(HANDOFF), STDIN_CLOSE]);
      c.runner.on('state', (t: Task) => { if (t.state === 'running') throw new Error('listener boom'); });
      await c.runner.start(c.task.id, []);
      const f = await finished(c);
      expect(f.outcome).toBe('failed');
      expect(f.reason).toMatch(/listener boom/);
      await sleep(300);
      expect(c.finished).toHaveLength(1);
      expect(getTask(c).state).toBe('failed');
      expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', onUnhandled); }
  }, 15000);

  it('stop right after start spawns no process', async () => {
    const c = setup([INIT(), USER, RESULT(HANDOFF), STDIN_CLOSE]);
    const started = c.runner.start(c.task.id, []);
    const stopped = c.runner.stop(c.task.id);
    await started;
    await stopped;
    expect(getTask(c).state).toBe('cancelled');
    expect(argvs()).toHaveLength(0);
    expect(c.finished).toEqual([{ taskId: c.task.id, outcome: 'cancelled' }]);
  }, 15000);

  it('stop with no run ends live session rows, expires inbox entries and cancels', async () => {
    const c = setup([STDIN_CLOSE]);
    tasks.transition(c.db, c.task.id, 'start');
    sessions.start(c.db, { missionId: c.missionId, taskId: c.task.id, role: 'implementer', pid: null, logPath: 'x.log' });
    inbox.add(c.db, { missionId: c.missionId, taskId: c.task.id, kind: 'question', payload: { question: 'q' } });
    await c.runner.stop(c.task.id);
    await c.runner.stop(c.task.id);
    expect(sessions.listLive(c.db)).toHaveLength(0);
    expect(inbox.openCountForTask(c.db, c.task.id)).toBe(0);
    expect(getTask(c).state).toBe('cancelled');
    expect(c.finished).toEqual([{ taskId: c.task.id, outcome: 'cancelled' }]);
  });

  it('a user message folded into the running turn: a result without handoff neither reminds nor fails', async () => {
    const c = setup([INIT(), USER, USER, RESULT('answered both, no handoff'), STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    c.runner.message(c.task.id, 'hi');
    while (getTask(c).tokensIn < 10) await sleep(20);
    await sleep(300);
    expect(getTask(c).state).toBe('running');
    expect(c.finished).toEqual([]);
    expect(userTexts().slice(1)).toEqual(['hi']);
  }, 15000);

  it('a reminder and a user message folded into one result do not fail with no-handoff', async () => {
    const c = setup([INIT(), USER, RESULT('none'), USER, USER, RESULT('still none'), STDIN_CLOSE]);
    await c.runner.start(c.task.id, []);
    while (userTexts().length < 2) await sleep(20);
    c.runner.message(c.task.id, 'hi');
    while (getTask(c).tokensIn < 20) await sleep(20);
    await sleep(300);
    expect(userTexts().slice(1)).toEqual(['Finish with a ## Handoff section.', 'hi']);
    expect(getTask(c).state).toBe('running');
    expect(c.finished).toEqual([]);
  }, 15000);

  it('stop after an ended run cancels the retried task', async () => {
    const c = setup([INIT(), USER, { exit: 1 }]);
    await c.runner.start(c.task.id, []);
    expect((await finished(c)).outcome).toBe('failed');
    tasks.transition(c.db, c.task.id, 'retry');
    tasks.transition(c.db, c.task.id, 'deps_met');
    inbox.add(c.db, { missionId: c.missionId, taskId: c.task.id, kind: 'question', payload: { question: 'q' } });
    await c.runner.stop(c.task.id);
    expect(getTask(c).state).toBe('cancelled');
    expect(inbox.openCountForTask(c.db, c.task.id)).toBe(0);
    expect(c.finished.map(f => f.outcome)).toEqual(['failed', 'cancelled']);
  }, 15000);
});
