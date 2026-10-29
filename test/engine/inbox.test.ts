import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { projects, missions, planVersions, tasks, inbox, permissionRules, Expired, AlreadyAnswered } from '../../src/store/repos.js';
import { buildGraph } from '../../src/core/plan/graph.js';
import { InboxService } from '../../src/engine/inbox.js';
import { SessionClosed } from '../../src/claude/session.js';

type Call = { requestId: string; decision: any };
function fakeSession(throwClosed = false) {
  const calls: Call[] = [];
  return {
    calls,
    answerPermission(requestId: string, decision: any) {
      if (throwClosed) throw new SessionClosed();
      calls.push({ requestId, decision });
    },
  };
}

const planTask = {
  key: 'T1', title: 'T', body: 'b', dependsOn: [], agent: 'implementer', owns: ['src/**'], acceptance: 'ok', estimate: 1,
};

function setup(session = fakeSession(), o: { settings?: unknown; agent?: string } = {}) {
  const db = openDb(':memory:');
  const p = projects.add(db, { name: 'demo', path: '/tmp/demo' });
  const m = missions.create(db, {
    projectId: p.id, title: 'M', brief: 'b', depth: 'thorough', baseBranch: 'main',
    missionBranch: 'maestro/m', isolation: 'worktree', maxParallel: 3, settings: o.settings,
  });
  const pv = planVersions.create(db, { missionId: m.id, version: 1, planPath: 'p', planMd: '#' });
  const pt = { ...planTask, agent: o.agent ?? planTask.agent };
  const [t] = tasks.insertPlan(db, m.id, pv.id, [pt], buildGraph([pt]));
  const reg = new Map<string, any>([['s1', session]]);
  const svc = new InboxService(db, { get: id => reg.get(id) });
  const changed: any[] = [];
  svc.on('changed', e => changed.push(e));
  return { db, m, t, svc, session, reg, changed };
}

const req = (requestId: string, toolName: string, input: unknown) =>
  ({ kind: 'permission-request' as const, requestId, toolName, input, toolUseId: 'tu', description: null });

describe('InboxService', () => {
  it('auto-allows a request that matches a mission rule without an inbox entry', () => {
    const s = setup();
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Bash', inputPrefix: 'npm install' });
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Bash', { command: 'npm install pg' }));
    expect(s.session.calls).toEqual([{ requestId: 'r1', decision: { allow: true, input: { command: 'npm install pg' } } }]);
    expect(inbox.listOpen(s.db, Date.now())).toHaveLength(0);
  });

  it('creates a permission entry and answers the session exactly once', () => {
    const s = setup();
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Write', { file_path: 'a' }));
    const [e] = inbox.listOpen(s.db, Date.now());
    expect(e.kind).toBe('permission');
    expect(s.changed.at(-1)).toEqual({ missionId: s.m.id, taskId: s.t.id });
    s.svc.answerPermission(e.id, { allow: true });
    expect(() => s.svc.answerPermission(e.id, { allow: true })).toThrow(AlreadyAnswered);
    expect(s.session.calls).toEqual([{ requestId: 'r1', decision: { allow: true, input: { file_path: 'a' } } }]);
  });

  it('denies with a message', () => {
    const s = setup();
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Write', {}));
    const [e] = inbox.listOpen(s.db, Date.now());
    s.svc.answerPermission(e.id, { allow: false, message: 'no' });
    expect(s.session.calls[0].decision).toEqual({ allow: false, message: 'no' });
  });

  it('always-allow stores the first two whitespace-separated words of a Bash command as the prefix (one word if the command has only one)', () => {
    const s = setup();
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Bash', { command: 'npm install pg' }));
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r2', 'Bash', { command: 'ls' }));
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r3', 'Write', { file_path: 'x' }));
    for (const e of inbox.listOpen(s.db, Date.now())) s.svc.answerPermission(e.id, { allow: true, always: true });
    const rows = s.db.prepare('SELECT tool_name, input_prefix FROM permission_rules ORDER BY tool_name, input_prefix').all();
    expect(rows).toEqual([
      { tool_name: 'Bash', input_prefix: 'ls' },
      { tool_name: 'Bash', input_prefix: 'npm install' },
      { tool_name: 'Write', input_prefix: '' },
    ]);
  });

  it('does not store a rule for unsafe or empty Bash commands and reports why', () => {
    const cmds = ['npm test && rm x', 'npm test\nrm x', 'echo $(whoami)', 'echo `id`', 'echo hi > f', 'Get-ChildItem -Recurse (Remove-Item x)', 'Get-ChildItem @(ls)', 'echo (id)', '   ', ''];
    for (const command of cmds) {
      const s = setup();
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Bash', { command }));
      const [e] = inbox.listOpen(s.db, Date.now());
      const r = s.svc.answerPermission(e.id, { allow: true, always: true });
      expect(r.ruleStored).toBe(false);
      if (command.trim() === '') expect(r.ruleSkippedReason).toMatch(/empty/);
      else expect(r.ruleSkippedReason).toMatch(/shell operators/);
      expect(s.db.prepare('SELECT COUNT(*) n FROM permission_rules').get()).toEqual({ n: 0 });
      expect(s.session.calls).toHaveLength(1);
    }
  });

  it('conductor requests (taskId null) are never auto-answered from rules and refuse "always"', () => {
    const s = setup();
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Bash', inputPrefix: 'npm install' });
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Write', inputPrefix: '' });
    s.svc.onPermissionRequest(s.m.id, null, 's1', req('r1', 'Bash', { command: 'npm install pg' }));
    s.svc.onPermissionRequest(s.m.id, null, 's1', req('r2', 'Write', { file_path: 'x' }));
    expect(s.session.calls).toHaveLength(0);
    const open = inbox.listOpen(s.db, Date.now());
    expect(open.map(e => e.taskId)).toEqual([null, null]);
    const before = s.db.prepare('SELECT COUNT(*) n FROM permission_rules').get();
    expect(() => s.svc.answerPermission(open[0].id, { allow: true, always: true })).toThrow(/conductor/i);
    expect(inbox.get(s.db, open[0].id)!.state).toBe('open'); // refused: still answerable
    expect(s.db.prepare('SELECT COUNT(*) n FROM permission_rules').get()).toEqual(before);
    expect(s.session.calls).toHaveLength(0);
    // Allow once and deny work.
    expect(s.svc.answerPermission(open[0].id, { allow: true }).ruleStored).toBe(false);
    s.svc.answerPermission(open[1].id, { allow: false });
    expect(s.session.calls.map(c => c.decision.allow)).toEqual([true, false]);
    // A task request still matches the same rules.
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r3', 'Bash', { command: 'npm install x' }));
    expect(s.session.calls).toHaveLength(3);
  });

  it('PowerShell always-allow is a two-word prefix and never covers chained commands', () => {
    const s = setup();
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'PowerShell', { command: 'Get-ChildItem -Recurse src' }));
    const [e] = inbox.listOpen(s.db, Date.now());
    expect(s.svc.answerPermission(e.id, { allow: true, always: true }).ruleStored).toBe(true);
    expect(s.db.prepare('SELECT tool_name, input_prefix FROM permission_rules').all())
      .toEqual([{ tool_name: 'PowerShell', input_prefix: 'Get-ChildItem -Recurse' }]);
    const auto = (command: string): boolean => {
      const n = s.session.calls.length;
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req(`q-${command}`, 'PowerShell', { command }));
      return s.session.calls.length > n;
    };
    expect(auto('Get-ChildItem -Recurse test')).toBe(true);
    expect(auto('Remove-Item -Recurse x')).toBe(false);
    for (const c of ['Get-ChildItem -Recurse; Remove-Item x', 'Get-ChildItem -Recurse | Remove-Item',
      'Get-ChildItem -Recurse & calc', 'Get-ChildItem -Recurse $(Remove-Item x)', 'Get-ChildItem -Recurse `n',
      'Get-ChildItem -Recurse > f', 'Get-ChildItem -Recurse\nRemove-Item x']) {
      expect(auto(c), c).toBe(false);
    }
    // Storing refuses chained PowerShell too.
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r9', 'PowerShell', { command: 'ls; rm x' }));
    const e9 = inbox.listOpen(s.db, Date.now()).find(x => x.requestId === 'r9')!;
    const r = s.svc.answerPermission(e9.id, { allow: true, always: true });
    expect(r.ruleStored).toBe(false);
    expect(r.ruleSkippedReason).toMatch(/shell operators/);
  });

  it('process substitution is a shell operator: never stored, never matched', () => {
    const s = setup();
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Bash', inputPrefix: 'git diff' });
    expect(permissionRules.match(s.db, s.m.id, 'Bash', { command: 'git diff <(rm -rf x)' })).toBe(false);
    expect(permissionRules.match(s.db, s.m.id, 'Bash', { command: 'git diff >(rm -rf x)' })).toBe(false);
    expect(permissionRules.match(s.db, s.m.id, 'Bash', { command: 'git diff HEAD' })).toBe(true);
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Bash', { command: 'cat <(rm -rf x)' }));
    const [e] = inbox.listOpen(s.db, Date.now());
    expect(s.svc.answerPermission(e.id, { allow: true, always: true }).ruleSkippedReason).toMatch(/shell operators/);
  });

  it('throws a clear error for a permission entry without a requestId', () => {
    const s = setup();
    const e = inbox.add(s.db, { missionId: s.m.id, taskId: s.t.id, kind: 'permission', payload: { toolName: 'Write', input: {}, sessionRowId: 's1' } });
    expect(() => s.svc.answerPermission(e.id, { allow: true })).toThrow(/requestId/);
    expect(s.session.calls).toHaveLength(0);
  });

  it('marks an entry undelivered (expired, answer kept) when the session is closed', () => {
    const s = setup(fakeSession(true));
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Write', {}));
    const [e] = inbox.listOpen(s.db, Date.now());
    const r = s.svc.answerPermission(e.id, { allow: true });
    expect(r.delivered).toBe(false);
    const got = inbox.get(s.db, e.id)!;
    expect(got.state).toBe('expired');
    expect(got.answer).toEqual({ allow: true });
  });

  it('ask resolves with the answer and rejects non-option answers', async () => {
    const s = setup();
    const p = s.svc.ask(s.m.id, s.t.id, 'Which?', ['a', 'b']);
    const [e] = inbox.listOpen(s.db, Date.now());
    expect(() => s.svc.answerQuestion(e.id, 'c')).toThrow(/option/);
    expect(inbox.listOpen(s.db, Date.now())).toHaveLength(1);
    s.svc.answerQuestion(e.id, 'b');
    await expect(p).resolves.toBe('b');
  });

  it('ask without options accepts free text', async () => {
    const s = setup();
    const p = s.svc.ask(s.m.id, null, 'Name?');
    const [e] = inbox.listOpen(s.db, Date.now());
    s.svc.answerQuestion(e.id, 'bob');
    await expect(p).resolves.toBe('bob');
  });

  it('rejects answers to expired entries without touching the session', async () => {
    const s = setup();
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Write', {}));
    const p = s.svc.ask(s.m.id, s.t.id, 'Q?');
    const entries = inbox.listOpen(s.db, Date.now());
    s.svc.expireForTask(s.t.id);
    await expect(p).rejects.toBeInstanceOf(Expired);
    for (const e of entries) {
      expect(() => (e.kind === 'permission' ? s.svc.answerPermission(e.id, { allow: true }) : s.svc.answerQuestion(e.id, 'x')))
        .toThrow(Expired);
    }
    expect(s.session.calls).toHaveLength(0);
  });

  it('permission-cancel expires the entry and writes nothing to the session', () => {
    const s = setup();
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Write', {}));
    const [e] = inbox.listOpen(s.db, Date.now());
    s.svc.onPermissionCancel('r1');
    expect(() => s.svc.answerPermission(e.id, { allow: true })).toThrow(Expired);
    expect(s.session.calls).toHaveLength(0);
  });

  it('expires the entry instead of crashing when the session is closed or missing', () => {
    const s = setup(fakeSession(true));
    s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Write', {}));
    s.svc.onPermissionRequest(s.m.id, s.t.id, 'gone', req('r2', 'Write', {}));
    const n = s.changed.length;
    for (const e of inbox.listOpen(s.db, Date.now())) s.svc.answerPermission(e.id, { allow: true });
    expect(inbox.listOpen(s.db, Date.now())).toHaveLength(0);
    expect(s.db.prepare("SELECT COUNT(*) n FROM inbox WHERE state='expired'").get()).toEqual({ n: 2 });
    expect(s.changed.length).toBeGreaterThan(n);
  });

  describe('pre-approved safe list (spec §9)', () => {
    const autoEvents = (db: any) =>
      (db.prepare("SELECT task_id, data_json FROM events WHERE type = 'auto-allowed' ORDER BY id").all() as any[])
        .map(r => ({ taskId: r.task_id, data: JSON.parse(r.data_json) }));
    const TASK = { safeScope: 'task' as const };
    const REVIEWER = { safeScope: 'reviewer' as const };

    /** setup() plus a real worktree folder for the task (with a package.json unless told otherwise). */
    function safeSetup(o: { settings?: unknown; packageJson?: boolean; session?: ReturnType<typeof fakeSession> } = {}) {
      const s = setup(o.session ?? fakeSession(), { settings: o.settings ?? { autoAllow: true } });
      const wt = mkdtempSync(join(tmpdir(), 'maestro-inbox-wt-'));
      if (o.packageJson !== false) writeFileSync(join(wt, 'package.json'), '{}');
      tasks.setRuntime(s.db, s.t.id, { worktreePath: wt });
      return s;
    }
    const bash = (requestId: string, command: string, extra: Record<string, unknown> = {}) =>
      req(requestId, 'Bash', { command, ...extra });

    it('auto-allows a safe task command, answers like the human path and records an auto-allowed event', () => {
      const s = safeSetup();
      const auto: any[] = [];
      s.svc.on('auto-allowed', e => auto.push(e));
      const input = { command: 'mkdir -p src test', description: 'make dirs' };
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Bash', input), TASK);
      expect(s.session.calls).toEqual([{ requestId: 'r1', decision: { allow: true, input } }]);
      expect(inbox.listOpen(s.db, Date.now())).toHaveLength(0);
      expect(autoEvents(s.db)).toEqual([{ taskId: s.t.id, data: { taskId: s.t.id, command: 'mkdir -p src test' } }]);
      expect(auto).toEqual([{ missionId: s.m.id, taskId: s.t.id }]);
      expect(s.changed).toHaveLength(0);
    });

    it('covers PowerShell too', () => {
      const s = safeSetup();
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'PowerShell', { command: 'git status' }), TASK);
      expect(s.session.calls).toHaveLength(1);
      expect(inbox.listOpen(s.db, Date.now())).toHaveLength(0);
    });

    it('an unsafe command still goes to the inbox', () => {
      const s = safeSetup({ settings: { autoAllow: true, autoRunTests: true } });
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'npm test 2>&1 | tail -15'), TASK);
      expect(s.session.calls).toHaveLength(0);
      expect(inbox.listOpen(s.db, Date.now())).toHaveLength(1);
      expect(autoEvents(s.db)).toEqual([]);
    });

    it('never auto-allows the conductor', () => {
      const s = safeSetup();
      s.svc.onPermissionRequest(s.m.id, null, 's1', bash('r1', 'git status'), TASK);
      expect(s.session.calls).toHaveLength(0);
      expect(inbox.listOpen(s.db, Date.now())).toHaveLength(1);
    });

    it('nothing is auto-allowed without a scope from the runner', () => {
      const s = safeSetup();
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'git status'));
      expect(s.session.calls).toHaveLength(0);
      expect(inbox.listOpen(s.db, Date.now())).toHaveLength(1);
    });

    it('only for shell tools: another tool with a command field is not covered', () => {
      const s = safeSetup();
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', req('r1', 'Task', { command: 'git status' }), TASK);
      expect(s.session.calls).toHaveLength(0);
      expect(inbox.listOpen(s.db, Date.now())).toHaveLength(1);
    });

    it('is off unless the mission settings say autoAllow: true', () => {
      for (const settings of [{}, { autoAllow: false }, { autoAllow: 'yes' }, { autoRunTests: true }]) {
        const s = safeSetup({ settings });
        s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'git status'), TASK);
        expect(s.session.calls).toHaveLength(0);
        expect(inbox.listOpen(s.db, Date.now())).toHaveLength(1);
      }
    });

    it('test runs are auto-allowed only with autoRunTests: true; git stays pre-approved either way', () => {
      for (const [settings, testAllowed] of [[{ autoAllow: true }, false], [{ autoAllow: true, autoRunTests: false }, false],
        [{ autoAllow: true, autoRunTests: 'yes' }, false], [{ autoAllow: true, autoRunTests: true }, true]] as const) {
        const s = safeSetup({ settings });
        s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'npm test'), TASK);
        s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r2', 'node --test'), TASK);
        s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r3', 'git diff'), TASK);
        expect(s.session.calls.map(c => c.requestId)).toEqual(testAllowed ? ['r1', 'r2', 'r3'] : ['r3']);
      }
    });

    it('npm test is not auto-allowed in a worktree without a package.json', () => {
      const s = safeSetup({ settings: { autoAllow: true, autoRunTests: true }, packageJson: false });
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'npm test'), TASK);
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r2', 'yarn test'), TASK);
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r3', 'node --test'), TASK);
      expect(s.session.calls.map(c => c.requestId)).toEqual(['r3']);
      expect(inbox.listOpen(s.db, Date.now()).map(e => e.requestId)).toEqual(['r1', 'r2']);
    });

    it('refuses inputs with keys other than command/description/timeout/run_in_background', () => {
      const s = safeSetup();
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'git status', { description: 'd', timeout: 1000, run_in_background: false }), TASK);
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r2', 'git status', { dangerouslyDisableSandbox: true }), TASK);
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r3', 'git status', { cwd: '/' }), TASK);
      expect(s.session.calls.map(c => c.requestId)).toEqual(['r1']);
      expect(inbox.listOpen(s.db, Date.now()).map(e => e.requestId)).toEqual(['r2', 'r3']);
    });

    it('a reviewer scope auto-allows npm test (when opted in) but sends git commit, mkdir and test args to the inbox', () => {
      const s = safeSetup({ settings: { autoAllow: true, autoRunTests: true } });
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'npm test'), REVIEWER);
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r2', 'git commit -m "x"'), REVIEWER);
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r3', 'mkdir src'), REVIEWER);
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r4', 'npm test -- --run'), REVIEWER);
      expect(s.session.calls.map(c => c.requestId)).toEqual(['r1']);
      expect(inbox.listOpen(s.db, Date.now()).map(e => e.requestId)).toEqual(['r2', 'r3', 'r4']);
    });

    it.each(['cd ..', 'cd /tmp && ls', 'Set-Location C:\\', 'pushd src', 'chdir x', 'sl ..', 'git status; cd x'])(
      'after the user allows %j, that session gets no more auto-allows (other sessions still do)', cmd => {
        const s = safeSetup();
        s.reg.set('s2', s.session);
        s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', cmd), TASK);
        const [e] = inbox.listOpen(s.db, Date.now());
        s.svc.answerPermission(e.id, { allow: true });
        s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r2', 'git status'), TASK);
        s.svc.onPermissionRequest(s.m.id, s.t.id, 's2', bash('r3', 'git status'), TASK);
        expect(s.session.calls.map(c => c.requestId)).toEqual(['r1', 'r3']);
        expect(inbox.listOpen(s.db, Date.now()).map(e2 => e2.requestId)).toEqual(['r2']);
      });

    it('a denied cd or a command that only mentions cd in a word does not stop auto-allow', () => {
      const s = safeSetup();
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'cd ..'), TASK);
      s.svc.answerPermission(inbox.listOpen(s.db, Date.now())[0].id, { allow: false });
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r2', 'npm install abcd'), TASK);
      s.svc.answerPermission(inbox.listOpen(s.db, Date.now())[0].id, { allow: true });
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r3', 'git status'), TASK);
      expect(s.session.calls.map(c => c.requestId)).toEqual(['r1', 'r2', 'r3']);
    });

    it('an always-allow rule that covers cd also stops auto-allow for the session', () => {
      const s = safeSetup();
      permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Bash', inputPrefix: 'cd src' });
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'cd src'), TASK);
      s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r2', 'git status'), TASK);
      expect(s.session.calls.map(c => c.requestId)).toEqual(['r1']);
      expect(inbox.listOpen(s.db, Date.now()).map(e => e.requestId)).toEqual(['r2']);
    });

    it('a session that is gone does not throw', () => {
      const s = safeSetup({ session: fakeSession(true) });
      expect(() => s.svc.onPermissionRequest(s.m.id, s.t.id, 's1', bash('r1', 'git status'), TASK)).not.toThrow();
      expect(inbox.listOpen(s.db, Date.now())).toHaveLength(0);
    });
  });
});
