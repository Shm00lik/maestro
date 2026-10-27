import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parsePlan } from '../../../src/core/plan/parsePlan.js';

const read = (name: string) =>
  readFileSync(new URL(`../../fixtures/plans/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('parsePlan', () => {
  it('parses the analytics fixture into 12 tasks', () => {
    const tasks = parsePlan(read('analytics.md'));
    expect(tasks.map(t => t.key)).toEqual(['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12']);
    const t6 = tasks[5];
    expect(t6).toMatchObject({ title: 'API endpoints (test-first)', dependsOn: ['T3','T4'], agent: 'implementer', owns: ['src/api/**','test/api/**'], estimate: 1 });
    expect(t6.acceptance).toContain('contract tests');
  });
  it('matches the expected dependency graph', () => {
    const g = parsePlan(read('analytics.md')).map(t => [t.key, t.dependsOn, t.agent]);
    expect(g).toEqual([
      ['T1', [], 'researcher'], ['T2', [], 'designer'], ['T3', ['T1'], 'architect'], ['T4', ['T1'], 'implementer'],
      ['T5', ['T3'], 'test-author'], ['T6', ['T3','T4'], 'implementer'], ['T7', ['T2','T3'], 'implementer'],
      ['T8', ['T6','T7'], 'implementer'], ['T9', ['T6'], 'code-reviewer'], ['T10', ['T4','T6'], 'qa'],
      ['T11', ['T8'], 'qa'], ['T12', ['T5','T9','T10','T11'], 'code-reviewer'],
    ]);
  });
  it('parses CRLF plans identically', () => {
    const md = read('analytics.md');
    expect(parsePlan(md.replace(/\n/g, '\r\n'))).toEqual(parsePlan(md));
  });
  it('treats none/dash/empty/missing as no dependencies', () => {
    for (const v of ['none', 'None', '-', '\u2014', '']) expect(parsePlan(`### Task 1: A\nDepends on: ${v}\nAgent: qa\n`)[0].dependsOn).toEqual([]);
    expect(parsePlan('### Task 1: A\nAgent: qa\n')[0].dependsOn).toEqual([]);
  });
  it('normalises dependency ids', () => {
    expect(parsePlan('### Task 2: B\nDepends on: t1,  Task 3 ,T4\nAgent: qa\n')[0].dependsOn).toEqual(['T1','T3','T4']);
  });
  it('reads Estimate as a number and ignores non-task headings', () => {
    const t = parsePlan('# Plan\n## Context\ntext\n### Task 1: A\nAgent: qa\nEstimate: 3\n');
    expect(t).toHaveLength(1); expect(t[0].estimate).toBe(3);
  });
  it('splits dependency tokens without a comma separator', () => {
    for (const v of ['T1 and T2', 'T1 T2', 'T1–T2', 'T1, T2, T1'])
      expect(parsePlan(`### Task 3: C\nDepends on: ${v}\nAgent: qa\n`)[0].dependsOn).toEqual(['T1','T2']);
  });
  it('strips a leading UTF-8 BOM', () => {
    const t = parsePlan('\uFEFF### Task 1: A\nAgent: qa\n');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ key: 'T1', agent: 'qa' });
  });
  it('keeps fenced code blocks in the body', () => {
    for (const f of ['```', '~~~']) {
      const fence = `${f}md\n## Not a heading\nOwns: nope\n### Task 9: Fake\n${f}`;
      const t = parsePlan(`### Task 1: A\nAgent: qa\nSee:\n${fence}\nOwns: src/real/**\nAcceptance: ok\n`);
      expect(t).toHaveLength(1);
      expect(t[0].owns).toEqual(['src/real/**']);
      expect(t[0].acceptance).toBe('ok');
      expect(t[0].body).toBe(`See:\n${fence}`);
    }
  });
  it('ignores task headings inside a fence outside any task', () => {
    expect(parsePlan('```\n### Task 1: A\nAgent: qa\n```\n### Task 2: B\nAgent: qa\n').map(t => t.key)).toEqual(['T2']);
  });
});
