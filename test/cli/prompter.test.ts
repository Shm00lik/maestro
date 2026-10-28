// Prompter unit tests: an in-memory database, a stub engine and scripted stdin lines.
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { openDb } from '../../src/store/db.js';
import { inbox, missions, planVersions, projects, tasks } from '../../src/store/repos.js';
import { buildGraph } from '../../src/core/plan/graph.js';
import { LineReader } from '../../src/cli/lineReader.js';
import { Prompter, describeInput } from '../../src/cli/prompter.js';
import type { MissionEngine } from '../../src/engine/missionEngine.js';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function setup() {
  const db = openDb(':memory:');
  const p = projects.add(db, { name: 'demo', path: '/tmp/demo' });
  const m = missions.create(db, {
    projectId: p.id, title: 'M', brief: 'b', depth: 'thorough', baseBranch: 'main',
    missionBranch: 'maestro/m', isolation: 'worktree', maxParallel: 3,
  });
  const pt = { key: 'T1', title: 'T', body: 'b', dependsOn: [], agent: 'implementer', owns: ['src/**'], acceptance: 'ok', estimate: 1 };
  const pv = planVersions.create(db, { missionId: m.id, version: 1, planPath: 'p', planMd: '#' });
  const [t] = tasks.insertPlan(db, m.id, pv.id, [pt], buildGraph([pt]));
  const calls: { op: string; args: unknown[] }[] = [];
  const engine = {
    approvePlan: (...args: unknown[]) => { calls.push({ op: 'approve', args }); },
    replan: (...args: unknown[]) => { calls.push({ op: 'replan', args }); },
    inbox: {
      answerPermission: (...args: unknown[]) => { calls.push({ op: 'permission', args }); return { delivered: true, ruleStored: false }; },
      answerQuestion: (...args: unknown[]) => { calls.push({ op: 'question', args }); },
    },
  } as unknown as MissionEngine;
  const input = new PassThrough();
  const reader = new LineReader(input);
  const lines: string[] = [];
  const prompts: string[] = [];
  const prompter = new Prompter({
    db, engine, missionId: m.id, reader, echo: false,
    out: l => lines.push(l), prompt: t => prompts.push(t), promptDone: () => undefined, onEof: () => undefined,
  });
  return { db, m, t, calls, input, prompter, lines, prompts };
}

async function waitFor(f: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(10); }
}

describe('Prompter', () => {
  it('a conductor permission request offers allow once / deny only', async () => {
    const s = setup();
    inbox.add(s.db, { missionId: s.m.id, taskId: null, kind: 'permission', requestId: 'r1',
      payload: { toolName: 'Bash', input: { command: 'npm test' }, description: null, toolUseId: 'tu', sessionRowId: 'x' } });
    s.prompter.refresh();
    await waitFor(() => s.prompts.length === 1);
    expect(s.prompts[0]).not.toMatch(/\[a\]/);
    s.input.write('a\n'); // not an option for the conductor
    await waitFor(() => s.prompts.length === 2);
    expect(s.lines.join('\n')).toMatch(/Invalid answer/);
    s.input.write('y\n');
    await waitFor(() => s.calls.length === 1);
    expect(s.calls[0]).toEqual({ op: 'permission', args: [expect.any(String), { allow: true, always: false }] });
    s.prompter.close();
  });

  it('a task permission request still offers always-allow', async () => {
    const s = setup();
    inbox.add(s.db, { missionId: s.m.id, taskId: s.t.id, kind: 'permission', requestId: 'r1',
      payload: { toolName: 'PowerShell', input: { command: 'Get-ChildItem src' }, description: null, toolUseId: 'tu', sessionRowId: 'x' } });
    s.prompter.refresh();
    await waitFor(() => s.prompts.length === 1);
    expect(s.prompts[0]).toMatch(/\[a\]/);
    expect(s.lines.join('\n')).toContain('PowerShell: Get-ChildItem src');
    s.prompter.close();
  });

  it('describeInput shows a PowerShell command as is', () => {
    expect(describeInput('PowerShell', { command: 'Get-ChildItem' })).toBe('Get-ChildItem');
  });

  it('plan approval: y / yes / ok approve, case-insensitively', async () => {
    for (const word of ['y', 'YES', 'Ok']) {
      const s = setup();
      inbox.add(s.db, { missionId: s.m.id, taskId: null, kind: 'plan_approval', payload: { version: 1, taskKeys: ['T1'], waves: [['T1']] } });
      s.prompter.refresh();
      await waitFor(() => s.prompts.length === 1);
      s.input.write(`${word}\n`);
      await waitFor(() => s.calls.length === 1);
      expect(s.calls[0].op, word).toBe('approve');
      s.prompter.close();
    }
  });

  it('plan approval shows the tasks from the entry (they are not in the database before approval)', async () => {
    const s = setup();
    inbox.add(s.db, { missionId: s.m.id, taskId: null, kind: 'plan_approval', payload: {
      version: 2, taskKeys: ['T7'], waves: [['T7']],
      tasks: [{ key: 'T7', title: 'New part', agent: 'debugger', dependsOn: ['T1'], owns: ['n/**'] }],
    } });
    s.prompter.refresh();
    await waitFor(() => s.prompts.length === 1);
    expect(s.lines.join('\n')).toContain('T7  New part  [debugger]  depends on: T1  owns: n/**');
    s.prompter.close();
  });

  it('plan approval: any other text asks before sending it as a re-plan note', async () => {
    const s = setup();
    inbox.add(s.db, { missionId: s.m.id, taskId: null, kind: 'plan_approval', payload: { version: 1, taskKeys: ['T1'], waves: [['T1']] } });
    s.prompter.refresh();
    await waitFor(() => s.prompts.length === 1);
    s.input.write('yep\n'); // a typo, not a note
    await waitFor(() => s.prompts.length === 2);
    expect(s.prompts[1]).toMatch(/Send this as a re-plan note\? \(y\/n\)/);
    s.input.write('n\n'); // back to the approval question
    await waitFor(() => s.prompts.length === 3);
    expect(s.calls).toEqual([]);
    s.input.write('Split part A\n');
    await waitFor(() => s.prompts.length === 4);
    s.input.write('y\n');
    await waitFor(() => s.calls.length === 1);
    expect(s.calls[0]).toEqual({ op: 'replan', args: [s.m.id, 'Split part A'] });
    s.prompter.close();
  });
});
