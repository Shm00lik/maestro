// Spec §12: what happens when Maestro starts again after a crash or a shutdown, and stuck-task detection.
// After a restart no task is silently restarted from scratch and no mission is left half-alive: Claude sessions are
// resumed with `--resume`, or the task / mission fails with a reason.
import type { Db } from '../store/db.js';
import { missions, sessions, tasks, type Mission } from '../store/repos.js';
import type { MissionEngine } from './missionEngine.js';

export const DEFAULT_STUCK_AFTER_MS = 20 * 60_000;

export interface RecoveryReport {
  /** Tasks resumed with `--resume <sessionId>` (confirmed, or still starting when the confirm wait ran out). */
  resumed: string[];
  /** Tasks whose resume failed (reason 'unrecoverable'). */
  failed: { taskId: string; reason: string }[];
  /** Tasks that had no Claude session yet, put back to ready and started through the normal start path. */
  restarted: string[];
  /** Tasks left untouched because a live session row with a living PID holds them (another Maestro instance?). */
  skipped: string[];
  /** Missions left untouched because their conductor's session row has a living PID. */
  skippedMissions: string[];
  /** Missions whose conductor was resumed with `--resume <conductor_session_id>`. */
  conductorsResumed: string[];
  /** Missions that failed with reason 'conductor-unrecoverable'. */
  missionsFailed: string[];
  /** Missions whose recovery threw (left as they were). */
  errors: { missionId: string; message: string }[];
}

/** process.kill(pid, 0): true while the process exists (EPERM means it exists but is not ours). */
export function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Runs once at engine start, before scheduling (MissionEngine.recover() calls it). In order:
 * 1. Live session rows: a row whose PID is alive belongs to someone else and is left alone (its task or mission is
 *    reported and untouched); every other live row is stale and ends.
 * 2. Each mission that has not ended (draft missions are left as they are) gets its engine context back: the task
 *    runner, the bridge, and the in-memory waits for its open plan_approval / merge_decision entries.
 * 3. The conductor: resumed with `--resume <conductor_session_id>` exactly once; if that process exits before it
 *    confirms the session, the mission fails with reason 'conductor-unrecoverable' (tasks and worktrees kept) and
 *    its tasks are not resumed. A conductor that never got a session id is started afresh (it had done nothing).
 * 4. Tasks in running / needs_you: resumed with `--resume <sessionId>` (failed with reason 'unrecoverable' when that
 *    fails), or, with no session id, put back to ready for the normal start path. Every other task is left to the
 *    scheduler as usual (done / failed / cancelled / planned are never re-dispatched or restarted).
 */
export async function recoverOnStartup(
  engine: MissionEngine, db: Db, isPidAlive: (pid: number) => boolean,
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    resumed: [], failed: [], restarted: [], skipped: [], skippedMissions: [], conductorsResumed: [], missionsFailed: [], errors: [],
  };
  const heldTasks = new Set<string>();
  const heldMissions = new Set<string>();
  for (const s of sessions.listLive(db)) {
    if (s.pid !== null && isPidAlive(s.pid)) {
      if (s.taskId) heldTasks.add(s.taskId);
      else heldMissions.add(s.missionId);
      continue;
    }
    sessions.end(db, s.id, 'ended');
  }

  const open = (db.prepare(
    "SELECT id FROM missions WHERE state NOT IN ('done', 'stopped', 'failed') ORDER BY created_at, rowid",
  ).all() as { id: string }[]).map(r => missions.get(db, r.id)!);

  for (const m of open) {
    if (engine.isClosed) break; // shutdown: stop without writing anything more
    if (m.state === 'draft') continue; // never started: nothing to resume
    if (heldMissions.has(m.id)) { report.skippedMissions.push(m.id); continue; }
    // One mission's failure (e.g. its project folder is gone) must not stop the others from recovering.
    try { await recoverMission(engine, db, m, heldTasks, report); }
    catch (e) { if (!engine.isClosed) report.errors.push({ missionId: m.id, message: (e as Error).message }); }
  }
  return report;
}

async function recoverMission(
  engine: MissionEngine, db: Db, m: Mission, heldTasks: Set<string>, report: RecoveryReport,
): Promise<void> {
  // Every await below can span a shutdown: re-check `isClosed` after each one and stop without writes.
  await engine.attachForRecovery(m.id);
  if (engine.isClosed) return;
  const cur = missions.get(db, m.id);
  if (!cur || cur.state === 'done' || cur.state === 'stopped' || cur.state === 'failed') return; // e.g. merge had landed
  if (m.conductorSessionId) {
    const ok = await engine.resumeConductor(m.id, m.conductorSessionId);
    if (engine.isClosed) return;
    if (!ok) { report.missionsFailed.push(m.id); return; }
    report.conductorsResumed.push(m.id);
  } else {
    engine.startConductorForRecovery(m.id);
  }

  const toResume: string[] = [];
  for (const t of tasks.listByMission(db, m.id)) {
    if (t.state !== 'running' && t.state !== 'needs_you') continue;
    if (heldTasks.has(t.id)) { engine.holdTask(t.id); report.skipped.push(t.id); continue; }
    if (!t.sessionId) {
      engine.requeueTask(t.id);
      report.restarted.push(t.id);
      continue;
    }
    toResume.push(t.id);
  }
  const results = await Promise.all(toResume.map(async id => ({ id, ok: await engine.resumeTask(id) })));
  if (engine.isClosed) return;
  for (const r of results) {
    if (r.ok) { report.resumed.push(r.id); continue; }
    const t = tasks.get(db, r.id);
    report.failed.push({ taskId: r.id, reason: t?.failureReason ?? 'unrecoverable' });
  }
}

/** The latest event time of a task (its stream activity, state changes, merges), or its start time. */
export function lastActivity(db: Db, taskId: string): number {
  const r = db.prepare(`SELECT MAX(e.ts) AS last, t.started_at AS started FROM tasks t
    LEFT JOIN events e ON e.task_id = t.id WHERE t.id = ?`).get(taskId) as { last: number | null; started: number | null } | undefined;
  return r?.last ?? r?.started ?? 0;
}

/** Ids of tasks in `running` whose last event is older than stuckAfterMs. */
export function checkStuck(db: Db, now: number, stuckAfterMs = DEFAULT_STUCK_AFTER_MS): string[] {
  const rows = db.prepare(`SELECT t.id AS id, COALESCE(MAX(e.ts), t.started_at, 0) AS last FROM tasks t
    LEFT JOIN events e ON e.task_id = t.id WHERE t.state = 'running' GROUP BY t.id ORDER BY t.rowid`)
    .all() as { id: string; last: number }[];
  return rows.filter(r => now - r.last > stuckAfterMs).map(r => r.id);
}
