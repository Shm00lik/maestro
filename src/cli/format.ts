// One readable line per engine event, for `maestro run`.
import type { Db } from '../store/db.js';
import { tasks, type EventRow, type Task } from '../store/repos.js';

const fmtNum = (n: number): string => n.toLocaleString('en-US');

export function tokenLine(t: Pick<Task, 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite'>): string {
  return `tokens in ${fmtNum(t.tokensIn)} / out ${fmtNum(t.tokensOut)} / cache read ${fmtNum(t.tokensCacheRead)}`
    + ` / cache write ${fmtNum(t.tokensCacheWrite)}`;
}

const short = (s: string, n = 200): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The line for one event, or null for events not worth a line (e.g. periodic activity). */
export function formatEvent(db: Db, ev: EventRow): string | null {
  const task = ev.taskId ? tasks.get(db, ev.taskId) : undefined;
  const key = task?.taskKey ?? ev.taskId ?? '?';
  const d = (ev.data ?? {}) as Record<string, any>;
  switch (ev.type) {
    case 'state': {
      if (!ev.taskId) return `[mission] ${d.from ?? '-'} -> ${d.to}`;
      if (d.event === 'dispatch' || d.event === 'retry') {
        const deps = task && task.dependsOn.length > 0 ? `, after ${task.dependsOn.join(', ')}` : '';
        return `[conductor] ${d.event === 'retry' ? 're-dispatched' : 'dispatched'} ${key} (${task?.agent ?? '?'}${deps})`;
      }
      const title = task?.title && task.title !== key ? ` ${task.title}` : '';
      let line = `[${key} ${d.to}]${title}`;
      if (task && (d.to === 'done' || d.to === 'failed' || d.to === 'cancelled')) {
        if (d.to === 'failed' && task.failureReason) line += ` — ${short(task.failureReason, 600)}`;
        line += ` — ${tokenLine(task)}`;
      }
      return line;
    }
    case 'merged': {
      const auto: string[] = Array.isArray(d.autoCommitted) ? d.autoCommitted : [];
      return `[${key} merged] into the mission branch${d.commit ? ` (${String(d.commit).slice(0, 7)})` : ''}`
        + (auto.length > 0 ? `; auto-committed leftovers: ${short(auto.join(', '), 400)}` : '');
    }
    case 'replan':
      return `[${key} replan] changed by the new plan`;
    case 'resume-failed':
      return `[${key} resume failed] ${short(String(d.detail ?? ''))}`;
    case 'inbox-undelivered':
      return `[${ev.taskId ? key : 'conductor'}] an answer could not be delivered (the session was gone)`;
    case 'conductor-subagent-warning':
      return `[conductor] WARNING: used the built-in ${d.tool} tool instead of dispatch_task (${d.count} so far)`;
    case 'conductor-exited':
      return `[conductor] exited with code ${d.code}${d.resumed ? ' (after a resume)' : ''}`;
    case 'merge-conflict':
      return `[merge] conflict in ${(d.files ?? []).join(', ')}`;
    case 'mission-failed':
      return `[mission] failed: ${d.reason}`;
    case 'activity':
      return null;
    default:
      return `[${ev.taskId ? key : 'mission'}] ${ev.type}${ev.data == null ? '' : ` ${short(JSON.stringify(ev.data))}`}`;
  }
}
