import { describe, it, expect } from 'vitest';
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

function setup(session = fakeSession()) {
  const db = openDb(':memory:');
  const p = projects.add(db, { name: 'demo', path: '/tmp/demo' });
  const m = missions.create(db, {
    projectId: p.id, title: 'M', brief: 'b', depth: 'thorough', baseBranch: 'main',
    missionBranch: 'maestro/m', isolation: 'worktree', maxParallel: 3,
  });
  const pv = planVersions.create(db, { missionId: m.id, version: 1, planPath: 'p', planMd: '#' });
  const [t] = tasks.insertPlan(db, m.id, pv.id, [planTask], buildGraph([planTask]));
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
    const cmds = ['npm test && rm x', 'npm test\nrm x', 'echo $(whoami)', 'echo `id`', 'echo hi > f', '   ', ''];
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
});
