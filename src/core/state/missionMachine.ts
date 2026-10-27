import { InvalidTransition } from './taskMachine.js';

export type MissionState =
  | 'draft' | 'understanding' | 'planning' | 'awaiting_approval' | 'running'
  | 'paused' | 'finishing' | 'done' | 'stopped' | 'failed';
export type MissionEvent =
  | 'start' | 'start_quick' | 'understood' | 'plan_submitted' | 'approve' | 'replan'
  | 'pause' | 'resume' | 'all_tasks_done' | 'merged' | 'stop' | 'fail';

// "Needs you" is intentionally not a mission state; it is derived from open inbox entries.
const TABLE: Record<MissionState, Partial<Record<MissionEvent, MissionState>>> = {
  draft: { start: 'understanding', start_quick: 'planning', stop: 'stopped', fail: 'failed' },
  understanding: { understood: 'planning', stop: 'stopped', fail: 'failed' },
  planning: { plan_submitted: 'awaiting_approval', stop: 'stopped', fail: 'failed' },
  awaiting_approval: { approve: 'running', replan: 'planning', stop: 'stopped', fail: 'failed' },
  running: {
    replan: 'planning', pause: 'paused', all_tasks_done: 'finishing', stop: 'stopped', fail: 'failed',
  },
  paused: { resume: 'running', stop: 'stopped', fail: 'failed' },
  finishing: { merged: 'done', stop: 'stopped', fail: 'failed' },
  done: {},
  stopped: {},
  failed: {},
};

export const TERMINAL_MISSION_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
  'done', 'stopped', 'failed',
]);

export function nextMissionState(from: MissionState, event: MissionEvent): MissionState {
  const to = TABLE[from]?.[event];
  if (!to) throw new InvalidTransition(from, event);
  return to;
}
