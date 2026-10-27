import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parsePlan } from '../../../src/core/plan/parsePlan.js';
import { buildGraph, ancestors, descendants } from '../../../src/core/plan/graph.js';

const read = (name: string) =>
  readFileSync(new URL(`../../fixtures/plans/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('graph', () => {
  const tasks = parsePlan(read('analytics.md'));
  it('computes waves and depth', () => {
    const g = buildGraph(tasks);
    expect(g.waves).toEqual([['T1','T2'],['T3','T4'],['T5','T6','T7'],['T8','T9','T10'],['T11'],['T12']]);
    expect(g.depth.T1).toBe(1);
    expect(g.depth.T12).toBe(6);
    expect(g.children.T3).toEqual(['T5','T6','T7']);
  });
  it('finds the critical path, tie-breaking to the lower key', () => {
    expect(buildGraph(tasks).criticalPath).toEqual(['T1','T3','T6','T8','T11','T12']);
  });
  it('estimates change the critical path', () => {
    const heavy = tasks.map(t => (t.key === 'T7' ? { ...t, estimate: 5 } : t));
    expect(buildGraph(heavy).criticalPath).toEqual(['T1','T3','T7','T8','T11','T12']);
  });
  it('computes ancestors and descendants', () => {
    expect([...ancestors(tasks, 'T8')].sort()).toEqual(['T1','T2','T3','T4','T6','T7']);
    expect([...descendants(tasks, 'T4')].sort()).toEqual(['T10','T12','T6','T8','T9','T11'].sort());
  });
  it('terminates on cyclic input', () => {
    const cyc = parsePlan('### Task 1: A\nDepends on: T2\nAgent: qa\n### Task 2: B\nDepends on: T1\nAgent: qa\n');
    expect([...ancestors(cyc, 'T1')].sort()).toEqual(['T1','T2']);
    expect([...descendants(cyc, 'T1')].sort()).toEqual(['T1','T2']);
  });
});
