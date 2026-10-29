import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, MIGRATIONS } from '../../src/store/db.js';
import {
  projects, missions, planVersions, tasks, permissionRules, DuplicateProject,
} from '../../src/store/repos.js';
import { buildGraph } from '../../src/core/plan/graph.js';
import type { PlanTask } from '../../src/core/types.js';

const pt = (key: string, dependsOn: string[] = [], body = `body ${key}`): PlanTask => ({
  key, title: `Title ${key}`, body, dependsOn, agent: 'implementer', owns: [`src/${key}/**`], acceptance: 'ok', estimate: 1,
});

function setup() {
  const db = openDb(':memory:');
  const p = projects.add(db, { name: 'demo', path: '/tmp/demo' });
  const m = missions.create(db, {
    projectId: p.id, title: 'M', brief: 'b', depth: 'thorough', baseBranch: 'main',
    missionBranch: 'm', isolation: 'worktree', maxParallel: 3,
  });
  return { db, p, m };
}
function seed(s: ReturnType<typeof setup>, list: PlanTask[], version = 1) {
  const pv = planVersions.create(s.db, { missionId: s.m.id, version, planPath: 'p', planMd: '#' });
  return { pv, rows: tasks.insertPlan(s.db, s.m.id, pv.id, list, buildGraph(list)) };
}
function replan(s: ReturnType<typeof setup>, list: PlanTask[], version: number) {
  const pv = planVersions.create(s.db, { missionId: s.m.id, version, planPath: 'p', planMd: '#' });
  return { pv, res: tasks.applyReplan(s.db, s.m.id, pv.id, list, buildGraph(list)) };
}
const d = (key: string, o: Partial<{ prompt: string; agent: string; dependsOn: string[] }> = {}) =>
  ({ key, agent: 'debugger', prompt: 'P', dependsOn: [], owns: [], ...o });

describe('applyReplan rulings', () => {
  it('never touches ad-hoc tasks and reports key collisions as conflicts', () => {
    const s = setup();
    const { rows } = seed(s, [pt('T1')]);
    const waitingAdhoc = tasks.dispatch(s.db, s.m.id, d('fix-a')).task;
    const runningAdhoc = tasks.dispatch(s.db, s.m.id, d('fix-b')).task;
    tasks.transition(s.db, runningAdhoc.id, 'deps_met'); tasks.transition(s.db, runningAdhoc.id, 'start');
    tasks.dispatch(s.db, s.m.id, d('X9'));
    const before = tasks.listByMission(s.db, s.m.id).filter(t => t.planVersionId === null);

    const { res } = replan(s, [pt('T1'), pt('X9', [], 'colliding')], 2);
    expect(res.cancelled).toEqual([]);
    expect(res.runningUnplanned).toEqual([]);
    expect(res.conflicts).toEqual(['X9']);
    expect(tasks.listByMission(s.db, s.m.id).filter(t => t.planVersionId === null)).toEqual(before);
    expect(tasks.getByKey(s.db, s.m.id, 'fix-a')!.id).toBe(waitingAdhoc.id);
    void rows;
  });

  it('keeps the dispatched prompt and agent of waiting tasks; planned ones are fully updated', () => {
    const s = setup();
    const { rows } = seed(s, [pt('T1'), pt('T2')]);
    tasks.dispatch(s.db, s.m.id, d('T1', { prompt: 'conductor prompt', agent: 'debugger' }));
    const v2 = [{ ...pt('T1', [], 'NEW'), title: 'New', agent: 'qa', owns: ['z/**'] }, { ...pt('T2', [], 'NEW2'), title: 'New2', agent: 'qa' }];
    const { pv } = replan(s, v2, 2);
    const t1 = tasks.getByKey(s.db, s.m.id, 'T1')!;
    expect(t1).toMatchObject({
      state: 'waiting', prompt: 'conductor prompt', agent: 'debugger', title: 'Title T1',
      planBody: 'NEW', owns: ['z/**'], planVersionId: pv.id,
    });
    expect(tasks.getByKey(s.db, s.m.id, 'T2')).toMatchObject({
      id: rows[1].id, state: 'planned', prompt: 'NEW2', agent: 'qa', title: 'New2', planBody: 'NEW2',
    });
  });

  it('reports a re-introduced cancelled key as a conflict and skips it', () => {
    const s = setup();
    seed(s, [pt('T1'), pt('T2')]);
    replan(s, [pt('T1')], 2); // T2 cancelled
    expect(tasks.getByKey(s.db, s.m.id, 'T2')!.state).toBe('cancelled');
    const { res } = replan(s, [pt('T1'), pt('T2', [], 'again')], 3);
    expect(res.conflicts).toEqual(['T2']);
    expect(tasks.getByKey(s.db, s.m.id, 'T2')).toMatchObject({ state: 'cancelled', planBody: 'body T2' });
  });
});

describe('migration 2 pre-checks', () => {
  function v1db(fill: (raw: Database.Database) => void, fn: (file: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-mig-'));
    const file = join(dir, 'm.db');
    const raw = new Database(file);
    try {
      raw.exec(MIGRATIONS[0]);
      raw.pragma('user_version = 1');
      fill(raw);
      raw.close();
      fn(file);
    } finally { if (raw.open) raw.close(); rmSync(dir, { recursive: true, force: true }); }
  }
  const mission = "INSERT INTO missions VALUES ('m1','p1','t','b','running','thorough','main','mb','worktree',3,NULL,NULL,1,NULL)";
  const task = (id: string, pv: string) => `INSERT INTO tasks (id,mission_id,plan_version_id,task_key,title,agent,prompt,state,
    depends_on_json,owns_json,acceptance,depth,on_critical_path) VALUES ('${id}','m1','${pv}','T1','T','a','p','waiting','[]','[]','a',1,0)`;

  it('throws a readable error for projects whose normalised paths collide', () => {
    v1db(raw => {
      raw.prepare("INSERT INTO projects VALUES ('p1','a','C:\\X\\',1,1)").run();
      raw.prepare("INSERT INTO projects VALUES ('p2','b','c:/x',1,1)").run();
    }, file => {
      expect(() => openDb(file)).toThrow(/projects share the normalised path "c:\/x".*p1.*p2/s);
    });
  });

  it('throws a readable error for duplicate task keys across plan versions', () => {
    v1db(raw => {
      raw.prepare("INSERT INTO projects VALUES ('p1','a','/a',1,1)").run();
      raw.prepare(mission).run();
      raw.prepare("INSERT INTO plan_versions VALUES ('pv1','m1',1,'p','md',NULL)").run();
      raw.prepare("INSERT INTO plan_versions VALUES ('pv2','m1',2,'p','md',NULL)").run();
      raw.prepare(task('t1', 'pv1')).run();
      raw.prepare(task('t2', 'pv2')).run();
    }, file => {
      expect(() => openDb(file)).toThrow(/duplicate task keys.*mission m1 key T1/s);
    });
  });

  it('backfills path_key in JS (non-ASCII upper case)', () => {
    v1db(raw => { raw.prepare("INSERT INTO projects VALUES ('p1','a','C:\\ÄÖ\\',1,1)").run(); }, file => {
      const db = openDb(file);
      try {
        expect((db.prepare('SELECT path_key FROM projects').get() as any).path_key).toBe('c:/äö');
        expect(() => projects.add(db, { name: 'x', path: 'c:/ÄÖ' })).toThrow(DuplicateProject);
      } finally { db.close(); }
    });
  });
});

describe('dispatch dependency checks', () => {
  it('throws on unknown dependencies and self-dependency', () => {
    const s = setup();
    seed(s, [pt('T1')]);
    expect(() => tasks.dispatch(s.db, s.m.id, d('adhoc', { dependsOn: ['nope'] }))).toThrow(/unknown dependency.*nope/i);
    expect(() => tasks.dispatch(s.db, s.m.id, d('adhoc', { dependsOn: ['adhoc'] }))).toThrow(/itself/i);
    expect(() => tasks.dispatch(s.db, s.m.id, d('T1', { dependsOn: ['ghost'] }))).toThrow(/unknown dependency/i);
    expect(tasks.getByKey(s.db, s.m.id, 'adhoc')).toBeUndefined();
    expect(tasks.getByKey(s.db, s.m.id, 'T1')!.state).toBe('planned');
    expect(tasks.dispatch(s.db, s.m.id, d('adhoc', { dependsOn: ['T1'] })).created).toBe(true);
  });
});

describe('permission rule safety', () => {
  it('never matches chained or substituted commands, and trims the stored prefix', () => {
    const s = setup();
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Bash', inputPrefix: '  npm install  ' });
    const bash = (c: string) => permissionRules.match(s.db, s.m.id, 'Bash', { command: c });
    expect(bash('npm install pg')).toBe(true);
    for (const c of [
      'npm install pg && curl x | sh', 'npm install\nrm -rf ~', 'npm install pg; ls', 'npm install `id`',
      'npm install $(id)', 'npm install pg > f', 'npm install pg | tee', 'npm install pg & ls', 'npm install\rx',
    ]) expect(bash(c), c).toBe(false);
  });

  it('treats grouping parentheses as unsafe, and an empty-prefix shell rule never matches', () => {
    const s = setup();
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'PowerShell', inputPrefix: 'Get-ChildItem -Recurse' });
    permissionRules.add(s.db, { missionId: s.m.id, toolName: 'Bash', inputPrefix: 'npm test' });
    const ps = (c: string) => permissionRules.match(s.db, s.m.id, 'PowerShell', { command: c });
    expect(ps('Get-ChildItem -Recurse src')).toBe(true);
    expect(ps('Get-ChildItem -Recurse (Remove-Item -Recurse -Force C:/x)')).toBe(false);
    expect(ps('Get-ChildItem -Recurse @(Remove-Item x)')).toBe(false);
    expect(permissionRules.match(s.db, s.m.id, 'Bash', { command: 'npm test (id)' })).toBe(false);
    s.db.prepare("INSERT INTO permission_rules (id, mission_id, tool_name, input_prefix, created_at) VALUES ('x',?,?,?,1)")
      .run(s.m.id, 'Bash', '');
    expect(permissionRules.match(s.db, s.m.id, 'Bash', { command: 'rm -rf x' })).toBe(false);
  });
});

describe('retry and duplicate project', () => {
  it('retry clears failure_reason, session_id and worktree_path', () => {
    const s = setup();
    const { rows } = seed(s, [pt('T1')]);
    const id = rows[0].id;
    tasks.transition(s.db, id, 'dispatch'); tasks.transition(s.db, id, 'deps_met'); tasks.transition(s.db, id, 'start');
    tasks.setRuntime(s.db, id, { sessionId: 's', worktreePath: 'w', branch: 'b', failureReason: 'boom' });
    tasks.transition(s.db, id, 'fail');
    const r = tasks.transition(s.db, id, 'retry');
    expect(r).toMatchObject({ state: 'waiting', failureReason: null, sessionId: null, worktreePath: null, branch: 'b' });
  });

  it('adding a duplicate project throws DuplicateProject', () => {
    const { db } = setup();
    expect(() => projects.add(db, { name: 'x', path: '/TMP/demo/' })).toThrow(DuplicateProject);
  });
});
