import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parsePlan } from '../../../src/core/plan/parsePlan.js';
import { validatePlan } from '../../../src/core/plan/validatePlan.js';

const read = (name: string) =>
  readFileSync(new URL(`../../fixtures/plans/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const plan = (md: string) => parsePlan(md);
const codes = (tasks: ReturnType<typeof parsePlan>) => validatePlan(tasks).map(e => e.code);
const task = (n: number, o: { deps?: string; agent?: string; owns?: string; acc?: string | null } = {}) =>
  `### Task ${n}: T${n}\n` +
  (o.deps ? `Depends on: ${o.deps}\n` : '') +
  `Agent: ${o.agent ?? 'qa'}\n` +
  (o.owns ? `Owns: ${o.owns}\n` : '') +
  (o.acc === null ? '' : `Acceptance: ${o.acc ?? 'done'}\n`);
const cycleOf = (...keys: string[]) =>
  keys.map((k, i) => task(Number(k.slice(1)), { deps: keys[(i + 1) % keys.length] })).join('');
const overlap = (a: string, b: string, dep = false) =>
  validatePlan(plan(task(1, { owns: a }) + task(2, { owns: b, deps: dep ? 'T1' : undefined })));

describe('validatePlan', () => {
  it('accepts the analytics fixture', () => expect(validatePlan(parsePlan(read('analytics.md')))).toEqual([]));
  it('reports duplicate keys and empty plans', () => {
    expect(validatePlan([]).map(e => e.code)).toEqual(['empty-plan']);
    expect(codes(plan('### Task 1: A\nAgent: qa\nAcceptance: x\n### Task 1: B\nAgent: qa\nAcceptance: y\n'))).toContain('duplicate-key');
  });
  it('reports unknown and self dependencies', () => {
    const u = validatePlan(plan(task(1, { deps: 'T9' }))).find(e => e.code === 'unknown-dependency')!;
    expect(u.taskKeys).toEqual(['T1']);
    const s = validatePlan(plan(task(1, { deps: 'T1' })));
    expect(s.map(e => e.code)).toEqual(['self-dependency']);
  });
  it('reports a cycle naming every task in it', () => {
    const e = validatePlan(plan(cycleOf('T1', 'T2', 'T3'))).find(e => e.code === 'cycle')!;
    expect(new Set(e.taskKeys)).toEqual(new Set(['T1', 'T2', 'T3']));
  });
  it('reports unknown agents and missing acceptance', () => {
    expect(codes(plan(task(1, { agent: 'wizard' })))).toEqual(['unknown-agent']);
    expect(codes(plan(task(1, { acc: null })))).toEqual(['missing-acceptance']);
  });
  it('flags parent/child glob overlap only for parallel tasks', () => {
    expect(overlap('src/**', 'src/api/**')[0]).toMatchObject({ code: 'ownership-overlap', taskKeys: ['T1', 'T2'] });
    expect(overlap('src/**', 'src/api/**', true)).toEqual([]);
    expect(codes(plan(task(1, { owns: 'src/a.ts' }) + task(2, { owns: 'src/*.ts' })))).toEqual(['ownership-overlap']);
    expect(overlap('src/api/**', 'src/ui/**')).toEqual([]);
  });
  it('treats path-segment prefixes strictly and ignores empty owns', () => {
    expect(overlap('src/api/**', 'src/apix/**')).toEqual([]);
    expect(overlap('src' + String.fromCharCode(92) + 'api' + String.fromCharCode(92) + '**', 'src/api/x.ts').map(e => e.code)).toEqual(['ownership-overlap']);
    expect(validatePlan(plan(task(1) + task(2, { owns: 'src/**' })))).toEqual([]);
  });
  it('skips ownership checks for tasks in a cycle', () => {
    const md = task(1, { deps: 'T2', owns: 'src/**' }) + task(2, { deps: 'T1', owns: 'src/**' });
    expect(codes(plan(md))).toEqual(['cycle']);
  });
  it('does not flag overlapping owns for tasks related only transitively', () => {
    const md = task(1, { owns: 'src/**' }) + task(2, { deps: 'T1', owns: 'docs/**' }) + task(3, { deps: 'T2', owns: 'src/api/**' });
    expect(validatePlan(plan(md))).toEqual([]);
  });
  it('compares ownership case-insensitively and ignores a leading ./', () => {
    expect(overlap('Src/**', 'src/api/**').map(e => e.code)).toEqual(['ownership-overlap']);
    expect(overlap('./src/**', 'src/api/x.ts').map(e => e.code)).toEqual(['ownership-overlap']);
    expect(overlap('./SRC/api/**', 'src/API/x.ts').map(e => e.code)).toEqual(['ownership-overlap']);
  });
  it('sorts cycle members with the natural key comparator', () => {
    const e = validatePlan(plan(cycleOf('T10', 'T2', 'T1'))).find(e => e.code === 'cycle')!;
    expect(e.taskKeys).toEqual(['T1', 'T2', 'T10']);
  });
});
