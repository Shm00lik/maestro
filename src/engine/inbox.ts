// Routes Claude permission requests and questions into the user's inbox, auto-approves requests that match mission
// "always allow" rules, and delivers each answer back to the right Claude session exactly once.
import { EventEmitter } from 'node:events';
import type { Db } from '../store/db.js';
import { inbox, permissionRules, Expired, type InboxEntry } from '../store/repos.js';
import { SessionClosed, type ClaudeSession } from '../claude/session.js';
import type { StreamEvent } from '../claude/protocol.js';

export interface SessionRegistry { get(sessionRowId: string): ClaudeSession | undefined }

export type PermissionRequestEvent = Extract<StreamEvent, { kind: 'permission-request' }>;
export interface InboxChanged { missionId: string; taskId: string | null }
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

const UNSAFE_SHELL = /[\n\r;&|`>]|\$\(/;

export class InboxService extends EventEmitter {
  private pending = new Map<string, Pending>();

  constructor(private db: Db, private sessions: SessionRegistry) { super(); }

  private changed(missionId: string, taskId: string | null): void {
    this.emit('changed', { missionId, taskId } satisfies InboxChanged);
  }

  private getEntry(id: string): InboxEntry {
    const r = this.db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!r) throw new Error(`Inbox entry not found: ${id}`);
    return {
      id: r.id, missionId: r.mission_id, taskId: r.task_id, kind: r.kind, requestId: r.request_id ?? null,
      payload: r.payload_json == null ? null : JSON.parse(r.payload_json), state: r.state,
      answer: r.answer_json == null ? null : JSON.parse(r.answer_json), createdAt: r.created_at,
      answeredAt: r.answered_at, snoozedUntil: r.snoozed_until,
    };
  }

  onPermissionRequest(missionId: string, taskId: string | null, sessionRowId: string, ev: PermissionRequestEvent): void {
    if (permissionRules.match(this.db, missionId, ev.toolName, ev.input)) {
      try {
        this.sessions.get(sessionRowId)?.answerPermission(ev.requestId, { allow: true, input: ev.input });
      } catch (e) {
        if (!(e instanceof SessionClosed)) throw e;
      }
      return;
    }
    const payload: PermissionPayload = {
      toolName: ev.toolName, input: ev.input, description: ev.description, toolUseId: ev.toolUseId, sessionRowId,
    };
    inbox.add(this.db, { missionId, taskId, kind: 'permission', payload, requestId: ev.requestId });
    this.changed(missionId, taskId);
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

    // Store first: a second click gets AlreadyAnswered/Expired here and never reaches the session.
    inbox.answer(this.db, entryId, a);

    const result: PermissionAnswerResult = { delivered: false, ruleStored: false };
    if (a.allow && a.always) {
      const prefix = this.rulePrefix(p);
      if (prefix === null) result.ruleSkippedReason = 'command contains shell operators; allowed once only';
      else {
        permissionRules.add(this.db, { missionId: entry.missionId, toolName: p.toolName, inputPrefix: prefix });
        result.ruleStored = true;
      }
    }

    try {
      const session = this.sessions.get(p.sessionRowId);
      if (!session) throw new SessionClosed();
      session.answerPermission(
        entry.requestId ?? '',
        a.allow ? { allow: true, input: p.input } : { allow: false, message: a.message ?? 'Denied by the user' },
      );
      result.delivered = true;
    } catch (e) {
      if (!(e instanceof SessionClosed)) throw e;
      // The session is gone: the answer can never be delivered, so the entry is no longer actionable.
      this.db.prepare("UPDATE inbox SET state = 'expired' WHERE id = ?").run(entryId);
    }
    this.changed(entry.missionId, entry.taskId);
    return result;
  }

  /** Bash: first two words of the command (null if unsafe). Other tools: '' (any input). */
  private rulePrefix(p: PermissionPayload): string | null {
    if (p.toolName !== 'Bash') return '';
    const cmd = typeof p.input === 'object' && p.input !== null ? (p.input as Record<string, unknown>).command : undefined;
    if (typeof cmd !== 'string' || UNSAFE_SHELL.test(cmd)) return null;
    const words = cmd.trim().split(/\s+/).filter(Boolean);
    return words.length ? words.slice(0, 2).join(' ') : null;
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

  private rejectPending(entries: InboxEntry[]): void {
    for (const e of entries) {
      const pend = this.pending.get(e.id);
      if (!pend) continue;
      this.pending.delete(e.id);
      pend.reject(new Expired(e.id));
    }
  }
}
