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
});
