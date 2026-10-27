import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { projects, missions, planVersions, tasks, inbox, events } from '../../src/store/repos.js';
import { parsePlan } from '../../src/core/plan/parsePlan.js';
import { buildGraph } from '../../src/core/plan/graph.js';
import { InvalidTransition } from '../../src/core/state/taskMachine.js';

const read = (name: string) =>
  readFileSync(new URL(`../fixtures/plans/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function setup() {
  const db = openDb(':memory:');
  const p = projects.add(db, { name: 'demo', path: '/tmp/demo' });
  const m = missions.create(db, {
    projectId: p.id, title: 'Analytics', brief: 'add analytics', depth: 'thorough',
    baseBranch: 'main', missionBranch: 'maestro/analytics', isolation: 'worktree', maxParallel: 3,
  });
  return { db, p, m };
}

function seedPlan() {
  const s = setup();
  const planTasks = parsePlan(read('analytics.md'));
  const graph = buildGraph(planTasks);
  const pv = planVersions.create(s.db, { missionId: s.m.id, version: 1, planPath: 'plan.md', planMd: '# plan' });
  planVersions.approve(s.db, pv.id);
  const rows = tasks.insertPlan(s.db, s.m.id, pv.id, planTasks, graph);
  return { ...s, rows };
}

describe('store', () => {
  it('creates the schema and round-trips a project and mission', () => {
    const { db, p, m } = setup();
    expect(projects.list(db)).toEqual([p]);
    expect(m.state).toBe('draft');
    expect(missions.get(db, m.id)).toEqual(m);
    expect(missions.get(db, 'nope')).toBeUndefined();
  });

  it('insertPlan stores depth and on_critical_path from the graph', () => {
    const { db, m, rows } = seedPlan();
    expect(rows).toHaveLength(12);
    const list = tasks.listByMission(db, m.id);
    const t6 = list.find(t => t.taskKey === 'T6')!;
    const t7 = list.find(t => t.taskKey === 'T7')!;
    expect(t6.depth).toBe(3);
    expect(t6.onCriticalPath).toBe(true);
    expect(t7.onCriticalPath).toBe(false);
    expect(t6.state).toBe('waiting');
    expect(t6.dependsOn).toEqual(['T3', 'T4']);
    expect(t6.owns).toEqual(['src/api/**', 'test/api/**']);
  });

  it('transition goes through the state machine', () => {
    const { db, m, rows } = seedPlan();
    const t = rows[0];
    expect(tasks.transition(db, t.id, 'deps_met').state).toBe('ready');
    const nEvents = events.list(db, m.id).length;
    expect(() => tasks.transition(db, t.id, 'complete')).toThrow(InvalidTransition);
    expect(tasks.listByMission(db, m.id).find(x => x.id === t.id)!.state).toBe('ready');
    expect(events.list(db, m.id)).toHaveLength(nEvents);
    const log = events.list(db, m.id, { taskId: t.id });
    expect(log[0]).toMatchObject({ type: 'state', data: { from: 'waiting', to: 'ready', event: 'deps_met' } });

    expect(missions.transition(db, m.id, 'start').state).toBe('understanding');
    expect(() => missions.transition(db, m.id, 'merged')).toThrow(InvalidTransition);
    expect(missions.get(db, m.id)!.state).toBe('understanding');
  });

  it('throws a clear error on an unknown stored state', () => {
    const { db, m } = setup();
    db.prepare('UPDATE missions SET state = ? WHERE id = ?').run('bogus', m.id);
    expect(() => missions.transition(db, m.id, 'start')).toThrow(/unknown mission state/i);
  });

  it('addUsage accumulates tokens', () => {
    const { db, m, rows } = seedPlan();
    tasks.addUsage(db, rows[0].id, 10, 5);
    tasks.addUsage(db, rows[0].id, 3, 2);
    const t = tasks.listByMission(db, m.id).find(x => x.id === rows[0].id)!;
    expect([t.tokensIn, t.tokensOut]).toEqual([13, 7]);
  });

  it('listOpen hides answered and snoozed entries', () => {
    const { db, m } = setup();
    const a = inbox.add(db, { missionId: m.id, kind: 'question', payload: { q: 'a' } });
    const b = inbox.add(db, { missionId: m.id, kind: 'plan_approval', payload: {} });
    const c = inbox.add(db, { missionId: m.id, kind: 'permission', payload: {}, snoozedUntil: 2000 });
    expect(inbox.listOpen(db, 1000).map(e => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(inbox.listOpen(db, 3000).map(e => e.id).sort()).toEqual([a.id, b.id, c.id].sort());
    const ans = inbox.answer(db, a.id, { ok: true });
    expect(ans.state).toBe('answered');
    expect(ans.answer).toEqual({ ok: true });
    expect(inbox.listOpen(db, 1000).map(e => e.id)).toEqual([b.id]);
  });

  it('has no cost columns', () => {
    const { db } = setup();
    for (const t of ['tasks', 'missions', 'sessions']) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[];
      expect(cols.some(c => /cost/i.test(c.name))).toBe(false);
    }
  });
});
