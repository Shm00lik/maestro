export type TaskState = 'waiting' | 'ready' | 'running' | 'needs_you' | 'done' | 'failed' | 'cancelled';
export type TaskEvent =
  | 'deps_met' | 'start' | 'needs_user' | 'answered' | 'complete' | 'fail' | 'cancel' | 'retry';

export class InvalidTransition extends Error {
  constructor(public from: string, public event: string) {
    super(`Invalid transition: ${event} from ${from}`);
    this.name = 'InvalidTransition';
  }
}

const TABLE: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  waiting: { deps_met: 'ready', cancel: 'cancelled' },
  ready: { start: 'running', cancel: 'cancelled' },
  running: { needs_user: 'needs_you', complete: 'done', fail: 'failed', cancel: 'cancelled' },
  needs_you: { answered: 'running', fail: 'failed', cancel: 'cancelled' },
  done: {},
  failed: { retry: 'waiting' },
  cancelled: {},
};

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'cancelled']);

export function nextTaskState(from: TaskState, event: TaskEvent): TaskState {
  // Own-property checks only: inherited keys such as 'toString' must not pass the table.
  const row = Object.hasOwn(TABLE, from) ? TABLE[from] : undefined;
  const to = row && Object.hasOwn(row, event) ? row[event] : undefined;
  if (!to) throw new InvalidTransition(String(from), String(event));
  return to;
}
