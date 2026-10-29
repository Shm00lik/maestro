// `maestro run` end to end over fake-claude. The CLI runs as a child process with scripted stdin answers. A fake
// conductor cannot call MCP tools, so the conductor side is driven by the test-only --conductor-script hook
// (honoured only with MAESTRO_TEST=1), which calls the engine's bridge handlers in order.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../src/store/db.js';
import { missions } from '../../src/store/repos.js';
import { parseRunArgs } from '../../src/cli/maestro.js';

const FAKE = fileURLToPath(new URL('../fake-claude/fake-claude.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../../src/cli/maestro.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const T = 30_000;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();

// ---- scenarios -------------------------------------------------------------
const INIT = { emit: { type: 'system', subtype: 'init', model: 'm', cwd: 'c', tools: ['Read', 'Bash', 'Edit', 'Write'], permissionMode: 'default' } };
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
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
const PERMISSION = {
  emit: {
    type: 'control_request', request_id: 'req-$SESSION',
    request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm --version', description: 'Print npm version' },
      description: 'Print npm version', tool_use_id: 'tu-$SESSION',
    },
  },
  templated: true,
};
/** Asks to run a Bash command, then writes a file and ends with a handoff. */
const TASK_PERMISSION = [
  INIT, USER, PERMISSION, { waitFor: 'permission-answer' },
  { writeFile: 'out-$SESSION.txt', content: 'work\n' }, RESULT('Did it.\n\n## Handoff\nMade a file.'), { waitFor: 'stdin-close' },
];
const TASK_HANG = [INIT, USER, ...UNTIL_INTERRUPT];
/** Asks to run `command`, then finishes like TASK_PERMISSION. */
const TASK_COMMAND = (command: string) => [
  INIT, USER,
  { ...PERMISSION, emit: { ...PERMISSION.emit, request: { ...PERMISSION.emit.request, input: { command, description: 'Run it' } } } },
  ...TASK_PERMISSION.slice(3),
];
const ONE_TASK_SCRIPT = [
  { op: 'submit_plan', plan: 'plan.md' },
  { op: 'dispatch', task_id: 'T1', owns: ['a/**'] },
  { op: 'wait', tasks: ['T1'] },
  { op: 'finish', summary: 'Done.' },
];

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

// ---- fixture ---------------------------------------------------------------
let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-cli-'));
  root = mkdtempSync(join(tmpdir(), 'maestro-cli-repo-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'readme.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  writeFileSync(join(dir, 'plan.md'), PLAN);
  writeFileSync(join(dir, 'brief.md'), '# Demo mission\n\nBuild parts A and B, then join them.\n');
});

afterEach(() => {
  try {
    const wts = git(root, 'worktree', 'list', '--porcelain').split('\n')
      .filter(l => l.startsWith('worktree ')).map(l => l.slice(9).trim()).slice(1);
    for (const w of wts) { try { git(root, 'worktree', 'remove', '--force', w); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface CliResult { code: number | null; out: string; err: string }

/** Without askTests (and no test flag in extraArgs) the run passes --no-auto-run-tests, so nothing is asked at start-up. */
function runCli(o: {
  taskSteps: object[]; script: object[]; answers: string; extraArgs?: string[]; conductorSteps?: object[]; askTests?: boolean;
}): Promise<CliResult> {
  const extra = o.extraArgs ?? [];
  const testFlag = o.askTests || extra.some(a => a === '--auto-run-tests' || a === '--no-auto-run-tests' || a === '--no-auto-allow');
  const taskScenario = join(dir, 'task-scenario.json');
  const condScenario = join(dir, 'conductor-scenario.json');
  const scriptPath = join(dir, 'conductor-script.json');
  writeFileSync(taskScenario, JSON.stringify({ steps: o.taskSteps }));
  writeFileSync(condScenario, JSON.stringify({ steps: o.conductorSteps ?? CONDUCTOR_IDLE }));
  writeFileSync(scriptPath, JSON.stringify(o.script));
  const args = [
    '--import', TSX, CLI, 'run', '--project', root, '--brief', join(dir, 'brief.md'), '--quick',
    '--db', join(dir, 'maestro.db'), '--conductor-script', scriptPath, ...extra,
    ...(testFlag ? [] : ['--no-auto-run-tests']),
  ];
  const child = spawn(process.execPath, args, {
    cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MAESTRO_TEST: '1',
      MAESTRO_CLAUDE_EXE: process.execPath,
      MAESTRO_CLAUDE_EXE_ARGS: JSON.stringify(['--import', TSX, FAKE]),
      FAKE_CLAUDE_SCENARIO: taskScenario,
      FAKE_CLAUDE_LOG: join(dir, 'fake.jsonl'),
      MAESTRO_TEST_CONDUCTOR_SCENARIO: condScenario,
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.stdin.end(o.answers);
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { child.kill(); rej(new Error(`cli timed out\n--- stdout\n${out}\n--- stderr\n${err}`)); }, T - 3000);
    child.on('exit', code => { clearTimeout(timer); res({ code, out, err }); });
  });
}

const onlyMission = () => {
  const db = openDb(join(dir, 'maestro.db'));
  try {
    const id = (db.prepare('SELECT id FROM missions').get() as { id: string }).id;
    return missions.get(db, id)!;
  } finally { db.close(); }
};

describe('maestro run', () => {
  it('cli runs the fake 3-task mission with scripted answers', async () => {
    const script = [
      { op: 'submit_plan', plan: 'plan.md' },
      { op: 'dispatch', task_id: 'T1', owns: ['a/**'] },
      { op: 'dispatch', task_id: 'T2', owns: ['b/**'] },
      { op: 'wait', tasks: ['T1', 'T2'], mode: 'all' },
      { op: 'dispatch', task_id: 'T3', depends_on: ['T1', 'T2'], owns: ['c/**'] },
      { op: 'wait', tasks: ['T3'] },
      { op: 'finish', summary: 'All three parts are in.' },
    ];
    // Plan: y. T1/T2 permissions: y (once), a (always: T3's identical request is then auto-approved). Merge: k.
    const r = await runCli({ taskSteps: TASK_PERMISSION, script, answers: 'y\ny\na\nk\n', extraArgs: ['--parallel', '2'] });
    const all = r.out + r.err;
    expect(r.code, all).toBe(0);
    expect(r.out).toMatch(/Logs: .*logs/);
    expect(r.out).toContain('[plan] 3 tasks in 2 waves');
    expect(r.out).toContain('[conductor] dispatched T1');
    expect(r.out).toContain('[conductor] dispatched T3');
    expect(r.out).toMatch(/\[T1 running\]/);
    expect(r.out).toMatch(/\[T3 done\].*tokens/);
    expect(r.out).toMatch(/Bash: npm --version/);
    expect(r.out).toMatch(/Keep branch/);
    expect(r.out).toMatch(/Mission done \(kept\)/);
    expect(r.out.match(/Permission/g)?.length).toBe(2);
    const m = onlyMission();
    expect(m.state).toBe('done');
    expect(m.outcome).toBe('kept');
    expect(m.maxParallel).toBe(2);
    expect(git(root, 'rev-parse', 'main')).not.toBe(git(root, 'rev-parse', m.missionBranch));
  }, T);

  it('cli auto-allows a safe git command and prints it; test runs are still asked about', async () => {
    // Plan: y. npm test: y (asked). Merge: k.
    const r = await runCli({ taskSteps: TASK_COMMAND('git status'), script: ONE_TASK_SCRIPT, answers: 'y\nk\n' });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain('[T1] auto-allowed: git status');
    expect(r.out).not.toMatch(/Permission/);
    expect(r.out).toContain('test runs are asked about');
    expect(onlyMission().settings).toEqual({ autoAllow: true, autoRunTests: false });
  }, T);

  it('cli asks once whether tests may run unattended, explaining the risk; y auto-allows npm test', async () => {
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"node -e 0"}}\n');
    git(root, 'add', 'package.json');
    git(root, 'commit', '-m', 'package');
    // Start-up: an invalid answer, then y. Plan: y. Merge: k.
    const r = await runCli({ taskSteps: TASK_COMMAND('npm test'), script: ONE_TASK_SCRIPT, answers: 'maybe\ny\ny\nk\n', askTests: true });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain('could run any program on this machine as you without a prompt');
    expect(r.out).toContain('Invalid answer: type y or n');
    expect(r.out).toContain('[T1] auto-allowed: npm test');
    expect(onlyMission().settings).toEqual({ autoAllow: true, autoRunTests: true });
  }, T);

  it('cli: answering n at start-up keeps test runs asked about', async () => {
    writeFileSync(join(root, 'package.json'), '{}\n');
    git(root, 'add', 'package.json');
    git(root, 'commit', '-m', 'package');
    // Start-up: n. Plan: y. npm test: y. Merge: k.
    const r = await runCli({ taskSteps: TASK_COMMAND('npm test'), script: ONE_TASK_SCRIPT, answers: 'n\ny\ny\nk\n', askTests: true });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/Bash: npm test/);
    expect(r.out).not.toContain('auto-allowed');
    expect(onlyMission().settings).toEqual({ autoAllow: true, autoRunTests: false });
  }, T);

  it('cli --auto-run-tests skips the question', async () => {
    writeFileSync(join(root, 'package.json'), '{}\n');
    git(root, 'add', 'package.json');
    git(root, 'commit', '-m', 'package');
    const r = await runCli({ taskSteps: TASK_COMMAND('npm test'), script: ONE_TASK_SCRIPT, answers: 'y\nk\n', extraArgs: ['--auto-run-tests'] });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).not.toContain('unattended');
    expect(r.out).toContain('[T1] auto-allowed: npm test');
    expect(onlyMission().settings).toEqual({ autoAllow: true, autoRunTests: true });
  }, T);

  it('cli --no-auto-allow asks about a safe task command and does not ask about tests', async () => {
    const r = await runCli({ taskSteps: TASK_COMMAND('git status'), script: ONE_TASK_SCRIPT, answers: 'y\ny\nk\n', extraArgs: ['--no-auto-allow'] });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/Bash: git status/);
    expect(r.out).not.toContain('auto-allowed');
    expect(r.out).not.toContain('unattended');
    expect(r.out).toContain('Auto-allow is off');
    expect(onlyMission().settings).toEqual({ autoAllow: false, autoRunTests: false });
  }, T);

  it('parseRunArgs: the test flags', () => {
    const base = ['run', '--project', 'p', '--brief', 'b'];
    expect(parseRunArgs(base).autoRunTests).toBeUndefined();
    expect(parseRunArgs([...base, '--auto-run-tests']).autoRunTests).toBe(true);
    expect(parseRunArgs([...base, '--no-auto-run-tests']).autoRunTests).toBe(false);
    expect(() => parseRunArgs([...base, '--auto-run-tests', '--no-auto-run-tests'])).toThrow(/together/);
  });

  it('cli exits 1 when the mission is stopped', async () => {
    const script = [
      { op: 'submit_plan', plan: 'plan.md' },
      { op: 'dispatch', task_id: 'T1', owns: ['a/**'] },
      { op: 'ask_user', question: 'Carry on?', options: ['Yes', 'No'] },
    ];
    // Only the plan is answered; stdin then ends while the question waits, which stops the mission like Ctrl+C.
    const r = await runCli({ taskSteps: TASK_HANG, script, answers: 'y\n' });
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out).toMatch(/stopping the mission/i);
    expect(r.out).toMatch(/Mission stopped/);
    expect(onlyMission().state).toBe('stopped');
  }, T);

  it('cli re-prompts on invalid input', async () => {
    const script = [
      { op: 'submit_plan', plan: 'plan.md' },
      { op: 'ask_user', question: 'Pick a colour', options: ['Red', 'Blue'] },
      { op: 'ask_user', question: 'Name it' },
      { op: 'finish', summary: 'Nothing to merge.' },
    ];
    // Plan: '' (re-prompt), then a re-plan note confirmed with y, then y on the resubmitted plan. Options: 9, x
    // (re-prompt), 2. Free text: '' (re-prompt), then an answer. Merge: z (re-prompt), then k.
    const answers = ['', 'Split part A', 'y', 'y', '9', 'x', '2', '', 'Widget', 'z', 'k', ''].join('\n');
    const r = await runCli({ taskSteps: TASK_HANG, script, answers });
    const all = r.out + r.err;
    expect(r.code, all).toBe(0);
    expect(r.out.match(/Invalid answer/g)?.length, all).toBe(5);
    expect(r.out).toContain('[test-conductor] re-plan requested: Split part A');
    expect(r.out).toContain('[test-conductor] ask_user -> Blue');
    expect(r.out).toContain('[test-conductor] ask_user -> Widget');
    expect(onlyMission().outcome).toBe('kept');
  }, T);

  it('cli prints conductor text and turns a plain-text turn into a question answered back to the conductor', async () => {
    const say = (text: string) => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } } });
    const conductorSteps = [
      INIT, USER, say('Hello from the conductor. Which framework?'), RESULT('Hello from the conductor. Which framework?'),
      USER, say('Thanks. One more thing?'), RESULT('Thanks. One more thing?'), ...UNTIL_INTERRUPT,
    ];
    // The first question is answered; stdin then ends while the second waits, which stops the mission.
    const r = await runCli({ taskSteps: TASK_HANG, script: [], answers: 'React please\n', conductorSteps });
    const all = r.out + r.err;
    expect(r.code, all).toBe(1);
    expect(r.out).toContain('[conductor] Hello from the conductor. Which framework?');
    expect(r.out).toContain('Question from conductor: Hello from the conductor. Which framework?');
    expect(r.out).toContain('[conductor] Thanks. One more thing?');
    const userLines = readFileSync(join(dir, 'fake.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(l => l?.type === 'user').map(l => l.message.content);
    expect(userLines).toContain('React please');
  }, T);

  it('cli refuses the test conductor hook outside test mode', () => {
    const script = join(dir, 'conductor-script.json');
    writeFileSync(script, '[]');
    let code = 0;
    let err = '';
    try {
      execFileSync(process.execPath, [
        '--import', TSX, CLI, 'run', '--project', root, '--brief', join(dir, 'brief.md'),
        '--db', join(dir, 'maestro.db'), '--conductor-script', script,
      ], { env: { ...process.env, MAESTRO_TEST: '' }, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      code = (e as { status: number }).status;
      err = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(1);
    expect(err).toContain('Unknown option --conductor-script');
  }, T);
});
