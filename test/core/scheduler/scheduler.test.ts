import { describe, it, expect } from 'vitest';
import { pickTasksToStart, nextBackoffMs, type SchedulerInput, type ReadyTask } from '../../../src/core/scheduler/scheduler.js';

const t = (id: string, missionId: string, onCriticalPath: boolean, readyAt: number): ReadyTask => ({ id, missionId, onCriticalPath, readyAt });
const base = (o: Partial<SchedulerInput>): SchedulerInput => ({
  ready: [], runningByMission: {}, maxParallelByMission: {}, globalMax: 6, throttledUntil: null, now: 1000, ...o,
});

describe('pickTasksToStart', () => {
  it('starts critical-path tasks first, then oldest ready', () => {
    const ready = [t('a', 'M', false, 1), t('b', 'M', true, 5), t('c', 'M', false, 0), t('d', 'M', true, 2)];
    expect(pickTasksToStart(base({ ready, maxParallelByMission: { M: 8 } }))).toEqual(['d', 'b', 'c', 'a']);
  });

  it('respects per-mission and global limits', () => {
    const ready = [t('a1', 'A', false, 1), t('a2', 'A', false, 2), t('a3', 'A', false, 3), t('a4', 'A', false, 4)];
    expect(pickTasksToStart(base({ ready, runningByMission: { A: 2 }, maxParallelByMission: { A: 3 } }))).toEqual(['a1']);
    const r2 = [t('x', 'X', false, 1), t('y', 'Y', false, 2)];
    expect(pickTasksToStart(base({ ready: r2, runningByMission: { Z: 5 } }))).toEqual(['x']);
  });

  it('skips a full mission without blocking others', () => {
    const ready = [t('a', 'A', true, 1), t('b', 'B', false, 2)];
    expect(pickTasksToStart(base({ ready, runningByMission: { A: 3 } }))).toEqual(['b']);
  });

  it('returns nothing while throttled', () => {
    const ready = [t('a', 'A', false, 1)];
    expect(pickTasksToStart(base({ ready, throttledUntil: 1001 }))).toEqual([]);
    expect(pickTasksToStart(base({ ready, throttledUntil: 1000 }))).toEqual(['a']);
    expect(pickTasksToStart(base({ ready, throttledUntil: 5 }))).toEqual(['a']);
  });

  it('clamps mission limits to 1..8 and defaults to 3', () => {
    const many = (m: string) => Array.from({ length: 12 }, (_, i) => t(`${m}${i}`, m, false, i));
    const n = (limits: Record<string, number>, m: string) =>
      pickTasksToStart(base({ ready: many(m), maxParallelByMission: limits, globalMax: 100 })).length;
    expect(n({ M: 0 }, 'M')).toBe(1);
    expect(n({ M: -4 }, 'M')).toBe(1);
    expect(n({ M: 12 }, 'M')).toBe(8);
    expect(n({ M: 2.9 }, 'M')).toBe(2);
    expect(n({}, 'M')).toBe(3);
  });

  it('starts nothing when globalMax <= 0', () => {
    expect(pickTasksToStart(base({ ready: [t('a', 'A', true, 1)], globalMax: 0 }))).toEqual([]);
  });

  it('breaks ties by id for determinism', () => {
    const ready = [t('b', 'A', false, 1), t('a', 'A', false, 1)];
    expect(pickTasksToStart(base({ ready }))).toEqual(['a', 'b']);
  });
});

describe('nextBackoffMs', () => {
  it('doubles from 1 minute and caps at 30', () => {
    let v = nextBackoffMs(null);
    const seq = [v];
    for (let i = 0; i < 6; i++) { v = nextBackoffMs(v); seq.push(v); }
    expect(seq).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
  });
});
