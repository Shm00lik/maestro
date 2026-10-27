import { describe, it, expect } from 'vitest';
import {
  nextTaskState, InvalidTransition, TERMINAL_TASK_STATES,
  type TaskState, type TaskEvent,
} from '../../../src/core/state/taskMachine.js';

const STATES: TaskState[] = ['waiting', 'ready', 'running', 'needs_you', 'done', 'failed', 'cancelled'];
const EVENTS: TaskEvent[] = ['deps_met', 'start', 'needs_user', 'answered', 'complete', 'fail', 'cancel', 'retry'];

const TABLE: Array<[TaskState, TaskEvent, TaskState]> = [
  ['waiting', 'deps_met', 'ready'],
  ['ready', 'start', 'running'],
  ['running', 'needs_user', 'needs_you'],
  ['needs_you', 'answered', 'running'],
  ['running', 'complete', 'done'],
  ['running', 'fail', 'failed'],
  ['needs_you', 'fail', 'failed'],
  ['failed', 'retry', 'waiting'],
  ['waiting', 'cancel', 'cancelled'],
  ['ready', 'cancel', 'cancelled'],
  ['running', 'cancel', 'cancelled'],
  ['needs_you', 'cancel', 'cancelled'],
];

describe('taskMachine', () => {
  it('follows every row of the table', () => {
    for (const [from, event, to] of TABLE) expect(nextTaskState(from, event)).toBe(to);
  });

  it('allows cancel from every non-terminal state', () => {
    for (const s of ['waiting', 'ready', 'running', 'needs_you'] as TaskState[]) {
      expect(nextTaskState(s, 'cancel')).toBe('cancelled');
    }
  });

  it('rejects transitions out of terminal states', () => {
    for (const s of ['done', 'cancelled'] as TaskState[]) {
      expect(TERMINAL_TASK_STATES.has(s)).toBe(true);
      for (const e of EVENTS) expect(() => nextTaskState(s, e)).toThrow(InvalidTransition);
    }
    expect(TERMINAL_TASK_STATES.has('failed')).toBe(false);
  });

  it('rejects start from waiting', () => {
    expect(() => nextTaskState('waiting', 'start')).toThrow(InvalidTransition);
  });

  it('rejects every (state, event) pair not in the table', () => {
    const allowed = new Set(TABLE.map(([f, e]) => `${f}:${e}`));
    for (const s of STATES) for (const e of EVENTS) {
      if (!allowed.has(`${s}:${e}`)) expect(() => nextTaskState(s, e)).toThrow(InvalidTransition);
    }
  });

  it('InvalidTransition carries a useful message', () => {
    expect.assertions(3);
    try { nextTaskState('done', 'start'); } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransition);
      expect((err as Error).name).toBe('InvalidTransition');
      expect((err as Error).message).toBe('Invalid transition: start from done');
    }
  });

  it('rejects inherited Object.prototype keys as events or states', () => {
    for (const e of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(() => nextTaskState('waiting', e as any)).toThrow(InvalidTransition);
    }
    expect(() => nextTaskState('toString' as any, 'cancel')).toThrow(InvalidTransition);
    expect(() => nextTaskState('constructor' as any, 'toString' as any)).toThrow(InvalidTransition);
  });
});
