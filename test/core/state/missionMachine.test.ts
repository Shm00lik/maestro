import { describe, it, expect } from 'vitest';
import {
  nextMissionState, TERMINAL_MISSION_STATES,
  type MissionState, type MissionEvent,
} from '../../../src/core/state/missionMachine.js';
import { InvalidTransition } from '../../../src/core/state/taskMachine.js';

const STATES: MissionState[] = [
  'draft', 'understanding', 'planning', 'awaiting_approval', 'running', 'paused',
  'finishing', 'done', 'stopped', 'failed',
];
const EVENTS: MissionEvent[] = [
  'start', 'start_quick', 'understood', 'plan_submitted', 'approve', 'replan',
  'pause', 'resume', 'all_tasks_done', 'merged', 'stop', 'fail',
];
const TERMINAL: MissionState[] = ['done', 'stopped', 'failed'];
const NON_TERMINAL = STATES.filter((s) => !TERMINAL.includes(s));

const TABLE: Array<[MissionState, MissionEvent, MissionState]> = [
  ['draft', 'start', 'understanding'],
  ['draft', 'start_quick', 'planning'],
  ['understanding', 'understood', 'planning'],
  ['planning', 'plan_submitted', 'awaiting_approval'],
  ['awaiting_approval', 'approve', 'running'],
  ['awaiting_approval', 'replan', 'planning'],
  ['running', 'replan', 'planning'],
  ['running', 'pause', 'paused'],
  ['paused', 'resume', 'running'],
  ['running', 'all_tasks_done', 'finishing'],
  ['finishing', 'merged', 'done'],
  ...NON_TERMINAL.map((s): [MissionState, MissionEvent, MissionState] => [s, 'stop', 'stopped']),
  ...NON_TERMINAL.map((s): [MissionState, MissionEvent, MissionState] => [s, 'fail', 'failed']),
];

describe('missionMachine', () => {
  it('follows every row of the table', () => {
    for (const [from, event, to] of TABLE) expect(nextMissionState(from, event)).toBe(to);
  });

  it('rejects every event from terminal states', () => {
    expect([...TERMINAL_MISSION_STATES].sort()).toEqual([...TERMINAL].sort());
    for (const s of TERMINAL) for (const e of EVENTS) {
      expect(() => nextMissionState(s, e)).toThrow(InvalidTransition);
    }
  });

  it('rejects every (state, event) pair not in the table', () => {
    const allowed = new Set(TABLE.map(([f, e]) => `${f}:${e}`));
    for (const s of STATES) for (const e of EVENTS) {
      if (!allowed.has(`${s}:${e}`)) expect(() => nextMissionState(s, e)).toThrow(InvalidTransition);
    }
  });

  it('rejects inherited Object.prototype keys as events or states', () => {
    for (const e of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(() => nextMissionState('draft', e as any)).toThrow(InvalidTransition);
    }
    expect(() => nextMissionState('toString' as any, 'stop')).toThrow(InvalidTransition);
  });
});
