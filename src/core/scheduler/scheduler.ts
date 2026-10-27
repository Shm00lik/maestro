export interface ReadyTask { id: string; missionId: string; onCriticalPath: boolean; readyAt: number }

export interface SchedulerInput {
  ready: ReadyTask[];
  runningByMission: Record<string, number>;
  maxParallelByMission: Record<string, number>;
  globalMax: number;
  throttledUntil: number | null;
  now: number;
}

export const DEFAULT_MISSION_PARALLEL = 3;
export const DEFAULT_GLOBAL_PARALLEL = 6;

const MIN_MISSION_PARALLEL = 1;
const MAX_MISSION_PARALLEL = 8;
const BACKOFF_START_MS = 60_000;
const BACKOFF_CAP_MS = 1_800_000;

function missionLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_MISSION_PARALLEL;
  return Math.min(MAX_MISSION_PARALLEL, Math.max(MIN_MISSION_PARALLEL, Math.floor(raw)));
}

/** Decide which ready tasks start now. Pure. */
export function pickTasksToStart(input: SchedulerInput): string[] {
  const { ready, runningByMission, maxParallelByMission, globalMax, throttledUntil, now } = input;
  if (throttledUntil !== null && throttledUntil > now) return [];

  const running = Object.values(runningByMission).reduce((a, b) => a + b, 0);
  let globalSlots = Math.floor(globalMax) - running;
  if (!(globalSlots > 0)) return [];

  const sorted = [...ready].sort((a, b) =>
    Number(b.onCriticalPath) - Number(a.onCriticalPath) ||
    a.readyAt - b.readyAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const picked: string[] = [];
  const pickedByMission: Record<string, number> = {};
  for (const task of sorted) {
    if (globalSlots <= 0) break;
    const used = (runningByMission[task.missionId] ?? 0) + (pickedByMission[task.missionId] ?? 0);
    if (used >= missionLimit(maxParallelByMission[task.missionId])) continue;
    picked.push(task.id);
    pickedByMission[task.missionId] = (pickedByMission[task.missionId] ?? 0) + 1;
    globalSlots--;
  }
  return picked;
}

/** Rate-limit backoff: 1 min, doubling, capped at 30 min. */
export function nextBackoffMs(previousMs: number | null): number {
  if (previousMs === null) return BACKOFF_START_MS;
  return Math.min(previousMs * 2, BACKOFF_CAP_MS);
}
