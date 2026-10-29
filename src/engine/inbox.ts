// Routes Claude permission requests and questions into the user's inbox, auto-approves task-session requests that
// are on the pre-approved safe list or match mission "always allow" rules (never the conductor's), and delivers each
// answer back to the right session once.
import { EventEmitter } from 'node:events';
import type { Db } from '../store/db.js';
import { events, inbox, missions, permissionRules, tasks, Expired, SHELL_TOOLS, UNSAFE_SHELL, type InboxEntry } from '../store/repos.js';
import { SessionClosed, type ClaudeSession } from '../claude/session.js';
import type { StreamEvent } from '../claude/protocol.js';
import { isSafeTaskCommand, safeScopeFor } from './safeCommands.js';

export interface SessionRegistry { get(sessionRowId: string): ClaudeSession | undefined }

export type PermissionRequestEvent = Extract<StreamEvent, { kind: 'permission-request' }>;
export interface InboxChanged { missionId: string; taskId: string | null }
/** Emitted as 'auto-allowed' after a safe-list approval (its 'auto-allowed' event row is already written). */
export interface AutoAllowed { missionId: string; taskId: string }
export interface PermissionAnswerResult {
  /** True when the answer reached the session; false when the session was gone and the entry was expired instead. */
  delivered: boolean;
  /** True when an "always allow" rule was stored. */
  ruleStored: boolean;
  /** Why no rule was stored although `always` was requested. */
  ruleSkippedReason?: string;
}

interface PermissionPayload {
  toolName: string; input: unknown; description: string | null; toolUseId: string; sessionRowId: string;
}
interface QuestionPayload { question: string; options?: string[] }

interface Pending { resolve(answer: string): void; reject(err: Error): void; options?: string[] }

export class InboxService extends EventEmitter {
  private pending = new Map<string, Pending>();

  constructor(private db: Db, private sessions: SessionRegistry) { super(); }

  private changed(missionId: string, taskId: string | null): void {
    this.emit('changed', { missionId, taskId } satisfies InboxChanged);
  }

  private getEntry(id: string): InboxEntry {
    const e = inbox.get(this.db, id);
    if (!e) throw new Error(`Inbox entry not found: ${id}`);
    return e;
  }

  onPermissionRequest(missionId: string, taskId: string | null, sessionRowId: string, ev: PermissionRequestEvent): void {
    // The safe list and always-allow rules cover task sessions only: a conductor request (taskId null) always goes
    // to the user.
    if (taskId !== null) {
      const safe = this.safeCommand(missionId, taskId, ev);
      if (safe !== null) {
        events.append(this.db, { missionId, taskId, type: 'auto-allowed', data: { taskId, command: safe } });
        this.allow(sessionRowId, ev);
        this.emit('auto-allowed', { missionId, taskId } satisfies AutoAllowed);
        return;
      }
      if (permissionRules.match(this.db, missionId, ev.toolName, ev.input)) {
        this.allow(sessionRowId, ev);
        return;
      }
    }
    const payload: PermissionPayload = {
      toolName: ev.toolName, input: ev.input, description: ev.description, toolUseId: ev.toolUseId, sessionRowId,
    };
    inbox.add(this.db, { missionId, taskId, kind: 'permission', payload, requestId: ev.requestId });
    this.changed(missionId, taskId);
  }

  /** Allows a request without an inbox entry, exactly as a user's "allow once" would. */
  private allow(sessionRowId: string, ev: PermissionRequestEvent): void {
    try {
      this.sessions.get(sessionRowId)?.answerPermission(ev.requestId, { allow: true, input: ev.input });
    } catch (e) {
      if (!(e instanceof SessionClosed)) throw e;
    }
  }

  /**
   * Spec §9: the command of a Bash/PowerShell request from a task session when it is on the safe list for the task's
   * role and the mission has auto-allow on (settings.autoAllow === true, set by the engine); otherwise null.
   */
  private safeCommand(missionId: string, taskId: string, ev: PermissionRequestEvent): string | null {
    if (!SHELL_TOOLS.has(ev.toolName)) return null;
    const settings = missions.get(this.db, missionId)?.settings;
    if (typeof settings !== 'object' || settings === null || (settings as Record<string, unknown>).autoAllow !== true) return null;
    const task = tasks.get(this.db, taskId);
    if (!task || task.missionId !== missionId) return null;
    const cmd = typeof ev.input === 'object' && ev.input !== null ? (ev.input as Record<string, unknown>).command : undefined;
    if (typeof cmd !== 'string' || !isSafeTaskCommand(cmd, safeScopeFor(task.agent))) return null;
    return cmd;
  }

  /** The CLI cancelled a pending request (e.g. after an interrupt): expire the entry, write nothing to the session. */
  onPermissionCancel(requestId: string): void {
    const e = inbox.expireByRequestId(this.db, requestId);
    if (!e) return;
    this.rejectPending([e]);
    this.changed(e.missionId, e.taskId);
  }

  ask(missionId: string, taskId: string | null, question: string, options?: string[]): Promise<string> {
    const payload: QuestionPayload = options && options.length ? { question, options } : { question };
    const entry = inbox.add(this.db, { missionId, taskId, kind: 'question', payload });
    return new Promise<string>((resolve, reject) => {
      this.pending.set(entry.id, { resolve, reject, options: payload.options });
      this.changed(missionId, taskId);
    });
  }

  answerPermission(entryId: string, a: { allow: true; always?: boolean } | { allow: false; message?: string }): PermissionAnswerResult {
    const entry = this.getEntry(entryId);
    if (entry.kind !== 'permission') throw new Error(`Inbox entry ${entryId} is not a permission request`);
    const p = entry.payload as PermissionPayload;
    if (!entry.requestId) throw new Error(`Permission entry ${entryId} has no requestId; cannot answer the session`);
    if (a.allow && a.always && entry.taskId === null) {
      throw new Error('Always-allow is not available for conductor requests: allow once or deny');
    }

    // Store first: a second click gets AlreadyAnswered/Expired here and never reaches the session.
    inbox.answer(this.db, entryId, a);

    const result: PermissionAnswerResult = { delivered: false, ruleStored: false };
    if (a.allow && a.always) {
      // Intended: the rule is stored before delivery. The user chose "always", and that choice stands even if the
      // session turns out to be gone and this particular answer cannot be delivered.
      const prefix = this.rulePrefix(p);
      if (typeof prefix === 'object') result.ruleSkippedReason = prefix.skip;
      else {
        permissionRules.add(this.db, { missionId: entry.missionId, toolName: p.toolName, inputPrefix: prefix });
        result.ruleStored = true;
      }
    }

    try {
      const session = this.sessions.get(p.sessionRowId);
      if (!session) throw new SessionClosed();
      session.answerPermission(
        entry.requestId,
        a.allow ? { allow: true, input: p.input } : { allow: false, message: a.message ?? 'Denied by the user' },
      );
      result.delivered = true;
    } catch (e) {
      if (!(e instanceof SessionClosed)) throw e;
      // The session is gone: the answer can never be delivered, so the entry is no longer actionable.
      inbox.markUndelivered(this.db, entryId);
    }
    this.changed(entry.missionId, entry.taskId);
    return result;
  }

  /** Bash / PowerShell: first two words of the command. Other tools: '' (any input). Or a skip reason when no rule is safe. */
  private rulePrefix(p: PermissionPayload): string | { skip: string } {
    if (!SHELL_TOOLS.has(p.toolName)) return '';
    const cmd = typeof p.input === 'object' && p.input !== null ? (p.input as Record<string, unknown>).command : undefined;
    if (typeof cmd !== 'string' || cmd.trim() === '') return { skip: 'empty command; allowed once only' };
    if (UNSAFE_SHELL.test(cmd)) return { skip: 'command contains shell operators; allowed once only' };
    return cmd.trim().split(/\s+/).slice(0, 2).join(' ');
  }

  answerQuestion(entryId: string, answer: string): void {
    const entry = this.getEntry(entryId);
    if (entry.kind !== 'question') throw new Error(`Inbox entry ${entryId} is not a question`);
    const options = (entry.payload as QuestionPayload).options;
    if (options && !options.includes(answer)) {
      throw new Error(`Answer must be one of the options: ${options.join(', ')}`);
    }
    inbox.answer(this.db, entryId, answer);
    const pend = this.pending.get(entryId);
    this.pending.delete(entryId);
    pend?.resolve(answer);
    this.changed(entry.missionId, entry.taskId);
  }

  expireForTask(taskId: string): void {
    const expired = inbox.expireForTask(this.db, taskId);
    this.rejectPending(expired);
    for (const e of expired) this.changed(e.missionId, e.taskId);
  }

  /** Expires the mission-level (task_id NULL) open entries, e.g. the conductor's questions, when the mission stops. */
  expireForMission(missionId: string): void {
    const expired = inbox.expireMissionLevel(this.db, missionId);
    this.rejectPending(expired);
    if (expired.length > 0) this.changed(missionId, null);
  }

  /**
   * The conductor process is gone (crash before a resume): its open questions and permission requests (task_id NULL)
   * expire, as on restart recovery; the resumed conductor asks again. Plan approvals and merge decisions stay.
   */
  expireConductorEntries(missionId: string): void {
    const expired = inbox.listOpenForMission(this.db, missionId)
      .filter(e => e.taskId === null && (e.kind === 'question' || e.kind === 'permission'))
      .filter(e => inbox.expire(this.db, e.id))
      .map(e => ({ ...e, state: 'expired' as const }));
    this.rejectPending(expired);
    if (expired.length > 0) this.changed(missionId, null);
  }

  /** Shutdown: rejects every pending ask in memory; the entries stay open in the database. */
  detachPending(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  private rejectPending(entries: InboxEntry[]): void {
    for (const e of entries) {
      const pend = this.pending.get(e.id);
      if (!pend) continue;
      this.pending.delete(e.id);
      pend.reject(new Expired(e.id));
    }
  }
}
