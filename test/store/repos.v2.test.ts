import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, MIGRATIONS } from '../../src/store/db.js';
import {
  projects, missions, planVersions, tasks, inbox, permissionRules, sessions, usageWindow, Expired, AlreadyAnswered, DuplicateProject,
} from '../../src/store/repos.js';
import { buildGraph } from '../../src/core/plan/graph.js';
import type { PlanTask } from '../../src/core/types.js';

const pt = (key: string, dependsOn: string[] = [], body = `body ${key}`): PlanTask => ({
  key, title: `Title ${key}`, body, dependsOn, agent: 'implementer', owns: [`src/${key}/**`],
  acceptance: 'works', estimate: 1,
});

function setup() {
  const db = openDb(':memory:');
  const p = projects.add(db, { name: 'demo', path: '/tmp/demo' });
  const m = missions.create(db, {
    projectId: p.id, title: 'M', brief: 'b', depth: 'thorough', baseBranch: 'main',
    missionBranch: 'maestro/m', isolation: 'worktree', maxParallel: 3,
  });
  return { db, p, m };
}

function plan(s: ReturnType<typeof setup>, list: PlanTask[], version = 1) {
  const pv = planVersions.create(s.db, { missionId: s.m.id, version, planPath: 'p', planMd: '#' });
  return { pv, graph: buildGraph(list) };
}

const U = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

describe('migration 2', () => {
  it('migrates a version-1 db to version 2 keeping rows', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'maestro-mig-'));
    const file = join(dir, 'm.db');
    const raw = new Database(file);
    try {
      raw.exec(MIGRATIONS[0]);
      raw.pragma('user_version = 1');
      raw.prepare("INSERT INTO projects VALUES ('p1','demo','C:\\Demo\\',1,1)").run();
      raw.prepare(`INSERT INTO missions VALUES ('m1','p1','t','b','paused','thorough','main','mb','worktree',3,NULL,NULL,1,NULL)`).run();
      raw.prepare("INSERT INTO plan_versions VALUES ('pv1','m1',1,'p','md',NULL)").run();
      raw.prepare(`INSERT INTO tasks (id,mission_id,plan_version_id,task_key,title,agent,prompt,state,depends_on_json,owns_json,
        acceptance,depth,on_critical_path,tokens_in,tokens_out) VALUES ('t1','m1','pv1','T1','T','implementer','pr','waiting','[]','[]','a',0,1,7,8)`).run();
      raw.prepare(`INSERT INTO inbox (id,mission_id,task_id,kind,payload_json,state,created_at) VALUES ('i1','m1','t1','question','{}','open',5)`).run();
      raw.prepare("INSERT INTO events (mission_id,task_id,ts,type,data_json) VALUES ('m1','t1',1,'x','null')").run();
      raw.close();

      const db = openDb(file);
      try {
        expect(db.pragma('user_version', { simple: true })).toBe(2);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(db.pragma('foreign_key_check')).toEqual([]);
        expect(projects.list(db).map(p => p.path)).toEqual(['C:\\Demo\\']);
        expect(missions.get(db, 'm1')).toMatchObject({ title: 't', state: 'running', outcome: null });
        const t = tasks.getByKey(db, 'm1', 'T1')!;
        expect(t).toMatchObject({
          id: 't1', planVersionId: 'pv1', state: 'waiting', tokensIn: 7, tokensOut: 8, tokensCacheRead: 0,
          planBody: 'pr', dispatchedAt: null,
        });
        expect(inbox.listOpen(db, 10).map(e => e.id)).toEqual(['i1']);
        expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
        // new constraints are live after the rebuild
        expect(() => projects.add(db, { name: 'dup', path: 'c:/demo' })).toThrow(DuplicateProject);
        const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(r => r.name);
        expect(names).toEqual(expect.arrayContaining(['idx_tasks_mission', 'idx_inbox_mission']));
      } finally { db.close(); }
    } finally {
      if (raw.open) raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('state CHECKs match the v2 machines (planned in, paused out)', () => {
    const { db, m } = setup();
    expect(() => db.prepare("UPDATE missions SET state = 'paused' WHERE id = ?").run(m.id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE missions SET outcome = 'x' WHERE id = ?").run(m.id)).toThrow(/CHECK/);
    const e = inbox.add(db, { missionId: m.id, kind: 'question', payload: {} });
    db.prepare("UPDATE inbox SET state = 'expired' WHERE id = ?").run(e.id);
  });
});

describe('projects', () => {
  it('project paths are unique after normalisation', () => {
    const { db } = setup();
    projects.add(db, { name: 'a', path: 'C:\\X\\' });
    expect(() => projects.add(db, { name: 'b', path: 'c:/x' })).toThrow(DuplicateProject);
    expect(projects.list(db).map(p => p.path)).toContain('C:\\X\\');
  });
});

describe('tasks v2', () => {
  it('dispatch moves a planned task to waiting and creates ad-hoc tasks', () => {
    const s = setup();
    const list = [pt('T1'), pt('T2', ['T1'])];
    const { pv, graph } = plan(s, list);
    const rows = tasks.insertPlan(s.db, s.m.id, pv.id, list, graph);
    expect(rows.every(r => r.state === 'planned' && r.planBody === `body ${r.taskKey}`)).toBe(true);

    const r = tasks.dispatch(s.db, s.m.id, { key: 'T1', agent: 'debugger', prompt: 'do it', dependsOn: [], owns: ['a/**'] });
    expect(r.created).toBe(false);
    expect(r.task).toMatchObject({ state: 'waiting', prompt: 'do it', agent: 'debugger', owns: ['a/**'] });
    expect(r.task.dispatchedAt).toBeTypeOf('number');
    expect(r.task.planBody).toBe('body T1');

    const adhoc = tasks.dispatch(s.db, s.m.id, { key: 'fix-1', agent: 'implementer', prompt: 'p', dependsOn: ['T1'], owns: [] });
    expect(adhoc.created).toBe(true);
    expect(adhoc.task).toMatchObject({ state: 'waiting', planVersionId: null, planBody: null, depth: 2, taskKey: 'fix-1' });
    expect(tasks.getByKey(s.db, s.m.id, 'fix-1')!.id).toBe(adhoc.task.id);
    expect(tasks.getByKey(s.db, s.m.id, 'nope')).toBeUndefined();
    expect(() => tasks.dispatch(s.db, s.m.id, { key: 'bad key!', agent: 'a', prompt: 'p', dependsOn: [], owns: [] })).toThrow(/invalid/i);
    expect(() => tasks.dispatch(s.db, s.m.id, { key: 'x'.repeat(25), agent: 'a', prompt: 'p', dependsOn: [], owns: [] })).toThrow(/invalid/i);
  });

  it('dispatch of an existing non-failed task returns created:false', () => {
    const s = setup();
    const { pv, graph } = plan(s, [pt('T1')]);
    const [t] = tasks.insertPlan(s.db, s.m.id, pv.id, [pt('T1')], graph);
    const d = { key: 'T1', agent: 'implementer', prompt: 'first', dependsOn: [], owns: [] };
    tasks.dispatch(s.db, s.m.id, d);
    const again = tasks.dispatch(s.db, s.m.id, { ...d, prompt: 'second' });
    expect(again.created).toBe(false);
    expect(again.task.prompt).toBe('first');
    tasks.transition(s.db, t.id, 'deps_met'); tasks.transition(s.db, t.id, 'start');
    expect(tasks.dispatch(s.db, s.m.id, { ...d, prompt: 'third' }).task).toMatchObject({ state: 'running', prompt: 'first' });
    tasks.transition(s.db, t.id, 'fail');
    const retry = tasks.dispatch(s.db, s.m.id, { ...d, prompt: 'retry' });
    expect(retry).toMatchObject({ created: false });
    expect(retry.task).toMatchObject({ state: 'waiting', prompt: 'retry', endedAt: null });
  });

  it('applyReplan keeps done tasks, updates planned ones, cancels removed ones, reports running ones', () => {
    const s = setup();
    const v1 = [pt('T1'), pt('T2', ['T1']), pt('T3', ['T1']), pt('T4'), pt('T5'), pt('T6')];
    const a = plan(s, v1);
    const rows = tasks.insertPlan(s.db, s.m.id, a.pv.id, v1, a.graph);
    const id = (k: string) => rows.find(r => r.taskKey === k)!.id;
    // T1 done, T4 running, T5 waiting, T6 ready, T2/T3 planned
    tasks.transition(s.db, id('T1'), 'dispatch'); tasks.transition(s.db, id('T1'), 'deps_met');
    tasks.transition(s.db, id('T1'), 'start'); tasks.transition(s.db, id('T1'), 'complete');
    tasks.transition(s.db, id('T4'), 'dispatch'); tasks.transition(s.db, id('T4'), 'deps_met');
    tasks.transition(s.db, id('T4'), 'start');
    tasks.transition(s.db, id('T5'), 'dispatch');
    tasks.transition(s.db, id('T6'), 'dispatch'); tasks.transition(s.db, id('T6'), 'deps_met');

    const v2 = [pt('T1', [], 'NEW1'), pt('T2', ['T1'], 'NEW2'), pt('T7', ['T2'], 'NEW7')];
    const b = plan(s, v2, 2);
    const res = tasks.applyReplan(s.db, s.m.id, b.pv.id, v2, b.graph);
    expect(res.cancelled.sort()).toEqual(['T3', 'T5', 'T6']);
    expect(res.runningUnplanned).toEqual(['T4']);

    const get = (k: string) => tasks.getByKey(s.db, s.m.id, k)!;
    expect(get('T1')).toMatchObject({ state: 'done', planVersionId: a.pv.id, planBody: 'body T1' });
    expect(get('T2')).toMatchObject({ state: 'planned', planVersionId: b.pv.id, planBody: 'NEW2', prompt: 'NEW2', id: id('T2') });
    expect(get('T3').state).toBe('cancelled');
    expect(get('T4').state).toBe('running');
    expect(get('T5').state).toBe('cancelled');
    expect(get('T6').state).toBe('cancelled');
    expect(get('T7')).toMatchObject({ state: 'planned', planVersionId: b.pv.id });
    expect(tasks.listByMission(s.db, s.m.id)).toHaveLength(7);
  });

  it('usage accumulates all four token kinds', () => {
    const s = setup();
    const { pv, graph } = plan(s, [pt('T1')]);
    const [t] = tasks.insertPlan(s.db, s.m.id, pv.id, [pt('T1')], graph);
    tasks.addUsage(s.db, t.id, U(1, 2, 3, 4));
    tasks.addUsage(s.db, t.id, U(10, 20, 30, 40));
    expect(tasks.getByKey(s.db, s.m.id, 'T1')).toMatchObject({
      tokensIn: 11, tokensOut: 22, tokensCacheRead: 33, tokensCacheWrite: 44,
    });
    expect(() => tasks.addUsage(s.db, 'nope', U())).toThrow(/task not found/i);
  });

  it('setRuntime updates only the given fields', () => {
    const s = setup();
    const { pv, graph } = plan(s, [pt('T1')]);
    const [t] = tasks.insertPlan(s.db, s.m.id, pv.id, [pt('T1')], graph);
    tasks.setRuntime(s.db, t.id, { sessionId: 's1', branch: 'b' });
    tasks.setRuntime(s.db, t.id, { handoffMd: 'h' });
    tasks.setRuntime(s.db, t.id, {});
    expect(tasks.getByKey(s.db, s.m.id, 'T1')).toMatchObject({
      sessionId: 's1', branch: 'b', handoffMd: 'h', worktreePath: null, failureReason: null,
    });
    expect(() => tasks.setRuntime(s.db, 'nope', { branch: 'x' })).toThrow(/task not found/i);
  });
});

describe('missions v2', () => {
  it('stores outcome and conductor session', () => {
    const { db, m } = setup();
    missions.setOutcome(db, m.id, 'merged');
    missions.setConductorSession(db, m.id, 'sess-1');
    expect(missions.get(db, m.id)).toMatchObject({ outcome: 'merged', conductorSessionId: 'sess-1' });
    expect(() => missions.setOutcome(db, 'nope', 'kept')).toThrow(/mission not found/i);
  });
});

describe('inbox v2', () => {
  it('expired entries cannot be answered', () => {
    const s = setup();
    const { pv, graph } = plan(s, [pt('T1')]);
    const [t] = tasks.insertPlan(s.db, s.m.id, pv.id, [pt('T1')], graph);
    const a = inbox.add(s.db, { missionId: s.m.id, taskId: t.id, kind: 'permission', payload: {}, requestId: 'r1' });
    const b = inbox.add(s.db, { missionId: s.m.id, taskId: t.id, kind: 'question', payload: {} });
    const c = inbox.add(s.db, { missionId: s.m.id, kind: 'question', payload: {}, requestId: 'r2' });
    expect(a.requestId).toBe('r1');
    expect(inbox.openCountForTask(s.db, t.id)).toBe(2);
    const exp = inbox.expireForTask(s.db, t.id);
    expect(exp.map(e => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(exp.every(e => e.state === 'expired')).toBe(true);
    expect(inbox.openCountForTask(s.db, t.id)).toBe(0);
    expect(() => inbox.answer(s.db, a.id, {})).toThrow(Expired);
    expect(() => inbox.answer(s.db, a.id, {})).not.toThrow(AlreadyAnswered);
    expect(inbox.listOpen(s.db, 0).map(e => e.id)).toEqual([c.id]);

    expect(inbox.expireByRequestId(s.db, 'nope')).toBeUndefined();
    expect(inbox.expireByRequestId(s.db, 'r2')).toMatchObject({ id: c.id, state: 'expired' });
    expect(inbox.expireByRequestId(s.db, 'r2')).toBeUndefined();
    expect(() => inbox.answer(s.db, c.id, {})).toThrow(Expired);
  });
});

describe('permission rules', () => {
  it('permission rules match by tool and exact command prefix', () => {
    const s = setup();
    const other = missions.create(s.db, {
      projectId: s.p.id, title: 'O', brief: 'b', depth: 'quick', baseBranch: 'main',
      missionBranch: 'o', isolation: 'worktree', maxParallel: 1,
    });
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Bash', inputPrefix: 'npm install' });
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Edit', inputPrefix: '' });
    const bash = (c: unknown) => permissionRules.match(s.db, s.m.id, 'Bash', { command: c });
    expect(bash('npm install')).toBe(true);
    expect(bash('npm install pg')).toBe(true);
    expect(bash('npm install\tpg')).toBe(true);
    expect(bash('npm installer')).toBe(false);
    expect(bash('npm i')).toBe(false);
    expect(bash(5)).toBe(false);
    expect(permissionRules.match(s.db, s.m.id, 'Bash', null)).toBe(false);
    expect(permissionRules.match(s.db, s.m.id, 'Edit', { file_path: 'x' })).toBe(true);
    expect(permissionRules.match(s.db, s.m.id, 'Write', {})).toBe(false);
    expect(permissionRules.match(s.db, other.id, 'Edit', {})).toBe(false);
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Read', inputPrefix: 'src' });
    expect(permissionRules.match(s.db, s.m.id, 'Read', {})).toBe(false);
  });
});

describe('sessions and usage window', () => {
  it('starts, lists and ends sessions', () => {
    const s = setup();
    const a = sessions.start(s.db, { missionId: s.m.id, role: 'conductor', pid: 42, logPath: 'l.log' });
    const b = sessions.start(s.db, { missionId: s.m.id, role: 'implementer', logPath: 'l2.log' });
    expect(a).toMatchObject({ state: 'live', taskId: null, pid: 42, logPath: 'l.log', endedAt: null, claudeSessionId: null });
    expect(sessions.listLive(s.db).map(x => x.id)).toEqual([a.id, b.id]);
    sessions.end(s.db, a.id, 'failed');
    expect(sessions.listLive(s.db).map(x => x.id)).toEqual([b.id]);
    expect(() => sessions.end(s.db, 'nope', 'ended')).toThrow(/session not found/i);
  });

  it('saves and reads the usage window (single row, nullable windows)', () => {
    const { db } = setup();
    expect(usageWindow.get(db)).toBeUndefined();
    usageWindow.save(db, { fiveHour: { utilization: 0.4, resetsAt: 100 }, sevenDay: null, seenAt: 5 });
    expect(usageWindow.get(db)).toEqual({ fiveHour: { utilization: 0.4, resetsAt: 100 }, sevenDay: null, seenAt: 5 });
    usageWindow.save(db, { fiveHour: null, sevenDay: { utilization: 0.1, resetsAt: 9 }, seenAt: 6 });
    expect(usageWindow.get(db)).toEqual({ fiveHour: null, sevenDay: { utilization: 0.1, resetsAt: 9 }, seenAt: 6 });
  });
});
