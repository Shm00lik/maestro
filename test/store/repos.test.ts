import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb, MIGRATIONS } from '../../src/store/db.js';
import { projects, missions, planVersions, tasks, inbox, events, AlreadyAnswered } from '../../src/store/repos.js';
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

  it('rejects inherited keys as task events and leaves row and events unchanged', () => {
    const { db, m, rows } = seedPlan();
    const before = tasks.listByMission(db, m.id).find(x => x.id === rows[0].id)!;
    const nEvents = events.list(db, m.id).length;
    expect(() => tasks.transition(db, rows[0].id, 'toString' as any)).toThrow(InvalidTransition);
    expect(() => missions.transition(db, m.id, 'constructor' as any)).toThrow(InvalidTransition);
    expect(tasks.listByMission(db, m.id).find(x => x.id === rows[0].id)).toEqual(before);
    expect(missions.get(db, m.id)!.state).toBe('draft');
    expect(events.list(db, m.id)).toHaveLength(nEvents);
  });

  it('throws a clear error on an unknown stored state', () => {
    const { db, m } = setup();
    db.pragma('ignore_check_constraints = ON'); // simulate a row the CHECK constraint would reject
    db.prepare('UPDATE missions SET state = ? WHERE id = ?').run('bogus', m.id);
    db.pragma('ignore_check_constraints = OFF');
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

  it('addUsage and approve throw on an unknown id', () => {
    const { db } = seedPlan();
    expect(() => tasks.addUsage(db, 'nope', 1, 1)).toThrow(/task not found: nope/i);
    expect(() => planVersions.approve(db, 'nope')).toThrow(/plan version not found: nope/i);
  });

  it('answering an inbox entry twice throws AlreadyAnswered and keeps the first answer', () => {
    const { db, m } = setup();
    const a = inbox.add(db, { missionId: m.id, kind: 'question', payload: {} });
    const first = inbox.answer(db, a.id, { pick: 1 });
    expect(() => inbox.answer(db, a.id, { pick: 2 })).toThrow(AlreadyAnswered);
    const row = db.prepare('SELECT answer_json, answered_at FROM inbox WHERE id = ?').get(a.id) as any;
    expect(JSON.parse(row.answer_json)).toEqual({ pick: 1 });
    expect(row.answered_at).toBe(first.answeredAt);
    expect(() => inbox.answer(db, 'nope', {})).toThrow(/inbox entry not found: nope/i);
    expect(() => inbox.answer(db, 'nope', {})).not.toThrow(AlreadyAnswered);
  });

  it('events.list supports newest-first with a limit', () => {
    const { db, m } = setup();
    for (let i = 1; i <= 5; i++) events.append(db, { missionId: m.id, type: 'note', data: { i }, ts: i });
    expect(events.list(db, m.id).map(e => e.data.i)).toEqual([1, 2, 3, 4, 5]);
    expect(events.list(db, m.id, { limit: 2 }).map(e => e.data.i)).toEqual([1, 2]);
    expect(events.list(db, m.id, { order: 'desc', limit: 2 }).map(e => e.data.i)).toEqual([5, 4]);
    expect(events.list(db, m.id, { order: 'asc' }).map(e => e.data.i)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('task timestamps', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const at = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);

  it('sets started_at on start and ended_at on done', () => {
    const { db, rows } = seedPlan();
    const id = rows[0].id;
    expect(rows[0].startedAt).toBeNull();
    at(100); tasks.transition(db, id, 'deps_met');
    at(200); const r = tasks.transition(db, id, 'start');
    expect([r.startedAt, r.endedAt]).toEqual([200, null]);
    at(300); const d = tasks.transition(db, id, 'complete');
    expect([d.startedAt, d.endedAt]).toEqual([200, 300]);
  });

  it('sets ended_at on failed and cancelled, clears it on retry, resets started_at on restart', () => {
    const { db, rows } = seedPlan();
    const [a, b] = [rows[0].id, rows[1].id];
    at(10); tasks.transition(db, a, 'deps_met'); tasks.transition(db, a, 'start');
    at(20); expect(tasks.transition(db, a, 'fail').endedAt).toBe(20);
    at(30); const w = tasks.transition(db, a, 'retry');
    expect([w.state, w.endedAt, w.startedAt]).toEqual(['waiting', null, 10]);
    at(40); tasks.transition(db, a, 'deps_met');
    at(50); expect(tasks.transition(db, a, 'start').startedAt).toBe(50);
    at(60); const c = tasks.transition(db, b, 'cancel');
    expect([c.state, c.startedAt, c.endedAt]).toEqual(['cancelled', null, 60]);
  });
});

describe('schema', () => {
  it('a fresh db is at the latest schema version', () => {
    const db = openDb(':memory:');
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });

  /** Runs fn with a fresh temp dir; every db opened via the given opener is closed before cleanup. */
  function withTempDb(fn: (file: string, open: (f: string) => ReturnType<typeof openDb>) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-db-'));
    const opened: ReturnType<typeof openDb>[] = [];
    const open = (f: string) => { const db = openDb(f); opened.push(db); return db; };
    try { fn(join(dir, 'm.db'), open); } finally {
      for (const db of opened) if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('opening the same file twice is idempotent and keeps data', () => {
    withTempDb((file, open) => {
      const db1 = open(file);
      const p = projects.add(db1, { name: 'x', path: '/x' });
      db1.close();
      const db2 = open(file);
      expect(db2.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      expect(projects.list(db2)).toEqual([p]);
    });
  });

  it('refuses a db from a newer schema version', () => {
    withTempDb((file, open) => {
      const db1 = open(file);
      db1.pragma(`user_version = ${MIGRATIONS.length + 1}`);
      db1.close();
      expect(() => open(file)).toThrow(/newer/i);
    });
  });

  it('rejects duplicate plan versions and duplicate task keys', () => {
    const { db, m, rows } = seedPlan();
    expect(() => planVersions.create(db, { missionId: m.id, version: 1, planPath: 'p', planMd: 'x' })).toThrow(/UNIQUE/);
    const pvId = rows[0].planVersionId;
    const planTasks = parsePlan(read('analytics.md')).slice(0, 1);
    expect(() => tasks.insertPlan(db, m.id, pvId, planTasks, buildGraph(planTasks))).toThrow(/UNIQUE/);
  });

  it('rejects bogus inbox kinds and states via CHECK constraints', () => {
    const { db, m, rows } = seedPlan();
    expect(() => inbox.add(db, { missionId: m.id, kind: 'bogus' as any, payload: {} })).toThrow(/CHECK/);
    const e = inbox.add(db, { missionId: m.id, kind: 'question', payload: {} });
    expect(() => db.prepare("UPDATE inbox SET state = 'weird' WHERE id = ?").run(e.id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE tasks SET state = 'weird' WHERE id = ?").run(rows[0].id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE missions SET state = 'weird' WHERE id = ?").run(m.id)).toThrow(/CHECK/);
  });

  it('enforces foreign keys', () => {
    const { db, m } = seedPlan();
    const pv2 = planVersions.create(db, { missionId: m.id, version: 2, planPath: 'p', planMd: 'x' });
    const planTasks = parsePlan(read('analytics.md')).slice(0, 1);
    expect(() => tasks.insertPlan(db, 'no-such-mission', pv2.id, planTasks, buildGraph(planTasks)))
      .toThrow(/FOREIGN KEY/);
    expect(() => planVersions.create(db, { missionId: 'no-such-mission', version: 1, planPath: 'p', planMd: 'x' }))
      .toThrow(/FOREIGN KEY/);
    expect(tasks.listByMission(db, 'no-such-mission')).toEqual([]);
  });
});
