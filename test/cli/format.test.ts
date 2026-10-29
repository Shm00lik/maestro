import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { formatEvent } from '../../src/cli/format.js';

const ev = (data: unknown) => ({ id: 1, missionId: 'm', taskId: null, ts: 0, type: 'merged', data });

describe('formatEvent', () => {
  it('a merged line lists the auto-committed leftover files', () => {
    const db = openDb(':memory:');
    expect(formatEvent(db, ev({ commit: 'abcdef1234', autoCommitted: ['b.txt', 'src/c.ts'] })))
      .toBe('[? merged] into the mission branch (abcdef1); auto-committed leftovers: b.txt, src/c.ts');
    expect(formatEvent(db, ev({ commit: 'abcdef1234', autoCommitted: [] }))).toBe('[? merged] into the mission branch (abcdef1)');
  });

  it('a no-changes event prints that nothing was merged', () => {
    const db = openDb(':memory:');
    expect(formatEvent(db, { id: 1, missionId: 'm', taskId: null, ts: 0, type: 'no-changes', data: {} } as any))
      .toBe('[?] no changes to merge');
  });

  it('an auto-allowed event prints the command, cut to one short line', () => {
    const db = openDb(':memory:');
    const line = (command: string) =>
      formatEvent(db, { id: 1, missionId: 'm', taskId: null, ts: 0, type: 'auto-allowed', data: { taskId: 't', command } } as any);
    expect(line('npm test')).toBe('[?] auto-allowed: npm test');
    const long = line('git add ' + 'a/'.repeat(200));
    expect(long!.length).toBeLessThan(200);
    expect(long!.endsWith('…')).toBe(true);
  });

  it('a discarded read-only change is a warning that lists the files', () => {
    const db = openDb(':memory:');
    expect(formatEvent(db, { id: 1, missionId: 'm', taskId: null, ts: 0, type: 'read-only-changes-discarded', data: { files: ['a.txt', 'b/c.txt'] } } as any))
      .toBe('[?] WARNING: a read-only role left changes; discarded, not merged: a.txt, b/c.txt');
  });
});
