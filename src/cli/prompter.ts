// Turns the mission's open inbox entries into numbered terminal prompts, one at a time, oldest first, and answers
// them through the engine. Every permission request is answered by the human: there is no auto-approve.
import type { Db } from '../store/db.js';
import { inbox as inboxRepo, missions, tasks, type InboxEntry } from '../store/repos.js';
import { TERMINAL_MISSION_STATES } from '../core/state/missionMachine.js';
import { KEEP, MERGE, type MissionEngine } from '../engine/missionEngine.js';
import { CANCELLED, type LineReader } from './lineReader.js';

export interface PrompterOptions {
  db: Db;
  engine: MissionEngine;
  missionId: string;
  reader: LineReader;
  /** Writes one line. */
  out(line: string): void;
  /** Writes a prompt (no line ending); lines written while it waits re-show it. */
  prompt(text: string): void;
  /** The prompt got its line (or was abandoned). */
  promptDone(): void;
  /** Echo each answer (stdin is not a terminal, so the answer would not show otherwise). */
  echo: boolean;
  /** Stdin ended while an answer was needed. */
  onEof(): void;
}

const MAX_TRIES = 3;
/** Plan approval answers that approve (case-insensitive). */
const APPROVE_WORDS: readonly string[] = ['y', 'yes', 'ok'];
const GONE: unique symbol = Symbol('gone');

const short = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function describeInput(toolName: string, input: unknown): string {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if ((toolName === 'Bash' || toolName === 'PowerShell') && typeof o.command === 'string') return o.command;
  for (const k of ['file_path', 'path', 'notebook_path', 'url', 'pattern']) {
    if (typeof o[k] === 'string') return String(o[k]);
  }
  return short(JSON.stringify(input ?? null));
}

export class Prompter {
  private handled = new Set<string>();
  private tries = new Map<string, number>();
  private n = 0;
  private running = false;
  private dirty = false;
  private closed = false;
  private current: { id: string; cancel(): void } | null = null;

  constructor(private o: PrompterOptions) {}

  /** Call whenever the inbox may have changed. */
  refresh(): void {
    if (this.closed) return;
    const cur = this.current;
    if (cur && inboxRepo.get(this.o.db, cur.id)?.state !== 'open') cur.cancel();
    if (this.running) { this.dirty = true; return; }
    void this.loop();
  }

  /** No more prompts (the mission ended or Maestro is quitting); a prompt being shown is abandoned. */
  close(): void {
    this.closed = true;
    this.current?.cancel();
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      do {
        this.dirty = false;
        for (;;) {
          if (this.closed) return;
          const next = this.openEntries().find(e => !this.handled.has(e.id));
          if (!next) break;
          this.handled.add(next.id);
          try {
            await this.handle(next);
          } catch (e) {
            this.o.out(`  Could not answer: ${(e as Error).message}`);
            const tries = (this.tries.get(next.id) ?? 0) + 1;
            this.tries.set(next.id, tries);
            // Still open (e.g. a merge that could not start): ask again, a few times at most.
            if (tries < MAX_TRIES && inboxRepo.get(this.o.db, next.id)?.state === 'open') this.handled.delete(next.id);
          }
        }
      } while (this.dirty && !this.closed);
    } finally {
      this.running = false;
    }
  }

  /**
   * Open entries of every mission that has not ended, oldest first: this mission's, and those of missions that
   * recover() resumed from an earlier run (they are labelled with their title), so none is left unanswered.
   */
  private openEntries(): InboxEntry[] {
    const live = new Map<string, boolean>();
    return inboxRepo.listOpen(this.o.db, Date.now()).filter(e => {
      if (!live.has(e.missionId)) {
        const m = missions.get(this.o.db, e.missionId);
        live.set(e.missionId, m !== undefined && !TERMINAL_MISSION_STATES.has(m.state));
      }
      return live.get(e.missionId);
    });
  }

  private who(e: InboxEntry): string {
    const mission = e.missionId === this.o.missionId ? '' : ` (mission "${missions.get(this.o.db, e.missionId)?.title ?? e.missionId}")`;
    if (!e.taskId) return `conductor${mission}`;
    return `${tasks.get(this.o.db, e.taskId)?.taskKey ?? e.taskId}${mission}`;
  }

  /** Prompts until `parse` accepts the line. GONE when the entry no longer needs an answer or stdin ended. */
  private async ask<T>(entryId: string, text: string, hint: string, parse: (line: string) => T | undefined): Promise<T | typeof GONE> {
    for (;;) {
      if (this.closed) return GONE;
      this.o.prompt(`${text} `);
      let cancel!: () => void;
      const cancelled = new Promise<void>(res => { cancel = res; });
      this.current = { id: entryId, cancel };
      const line = await this.o.reader.read(cancelled);
      this.current = null;
      this.o.promptDone();
      if (line === CANCELLED) {
        this.o.out('');
        if (!this.closed) this.o.out('  (no longer needs an answer)');
        return GONE;
      }
      if (line === null) {
        this.o.out('');
        this.closed = true;
        this.o.onEof();
        return GONE;
      }
      if (this.o.echo) this.o.out(line);
      if (inboxRepo.get(this.o.db, entryId)?.state !== 'open') {
        this.o.out('  (no longer needs an answer)');
        return GONE;
      }
      const v = parse(line.trim());
      if (v !== undefined) return v;
      this.o.out(`  Invalid answer: ${hint}`);
    }
  }

  private async handle(e: InboxEntry): Promise<void> {
    const n = ++this.n;
    this.o.out('');
    switch (e.kind) {
      case 'permission': return this.permission(n, e);
      case 'question': return this.question(n, e);
      case 'plan_approval': return this.plan(n, e);
      case 'merge_decision': return this.merge(n, e);
      default:
        this.o.out(`#${n} ${e.kind} from ${this.who(e)} (not supported in the terminal yet): ${short(JSON.stringify(e.payload))}`);
    }
  }

  private async permission(n: number, e: InboxEntry): Promise<void> {
    const p = e.payload as { toolName: string; input: unknown; description: string | null };
    this.o.out(`#${n} Permission request from ${this.who(e)} — ${p.toolName}: ${describeInput(p.toolName, p.input)}`);
    if (p.description) this.o.out(`   ${p.description}`);
    if (p.toolName !== 'Bash' && p.toolName !== 'PowerShell') this.o.out(`   input: ${short(JSON.stringify(p.input ?? null), 1000)}`);
    // Always-allow rules cover task sessions only: the conductor's requests are answered one by one.
    const conductor = e.taskId === null;
    const choices = conductor ? ['y', 'n'] : ['y', 'a', 'n'];
    const a = await this.ask(e.id,
      conductor ? 'Allow? [y] once, [n] deny:' : 'Allow? [y] once, [a] always for this mission, [n] deny:',
      conductor ? 'type y or n' : 'type y, a or n',
      l => (choices.includes(l.toLowerCase()) ? l.toLowerCase() : undefined));
    if (a === GONE) return;
    if (a === 'n') {
      const reason = await this.ask(e.id, 'Reason (optional, Enter to skip):', '', l => l);
      if (reason === GONE) return;
      this.o.engine.inbox.answerPermission(e.id, reason ? { allow: false, message: reason } : { allow: false });
      this.o.out(`  Denied.`);
      return;
    }
    const r = this.o.engine.inbox.answerPermission(e.id, { allow: true, always: a === 'a' });
    if (!r.delivered) this.o.out('  The session was gone; the answer could not be delivered.');
    if (a === 'a') this.o.out(r.ruleStored ? '  Allowed, and always allowed for this mission.' : `  Allowed once only: ${r.ruleSkippedReason}.`);
    else this.o.out('  Allowed once.');
  }

  private async question(n: number, e: InboxEntry): Promise<void> {
    const p = e.payload as { question: string; options?: string[] };
    this.o.out(`#${n} Question from ${this.who(e)}: ${p.question}`);
    const options = p.options ?? [];
    let answer: string | typeof GONE;
    if (options.length > 0) {
      options.forEach((opt, i) => this.o.out(`   ${i + 1}) ${opt}`));
      answer = await this.ask(e.id, `Pick 1-${options.length}:`, `type a number from 1 to ${options.length}`, l => {
        if (!/^\d+$/.test(l)) return undefined;
        const i = Number(l);
        return i >= 1 && i <= options.length ? options[i - 1] : undefined;
      });
    } else {
      answer = await this.ask(e.id, 'Answer:', 'type an answer', l => (l ? l : undefined));
    }
    if (answer === GONE) return;
    this.o.engine.inbox.answerQuestion(e.id, answer);
  }

  private async plan(n: number, e: InboxEntry): Promise<void> {
    const p = e.payload as {
      version?: number; planPath?: string; taskKeys?: string[]; waves?: string[][]; criticalPath?: string[];
      cancelled?: string[]; runningUnplanned?: string[];
      tasks?: { key: string; title: string; agent: string; dependsOn: string[]; owns: string[] }[];
    };
    const keys = p.taskKeys ?? [];
    const waves = p.waves ?? [];
    this.o.out(`[plan] ${keys.length} tasks in ${waves.length} waves`);
    this.o.out(`#${n} Plan approval (version ${p.version ?? '?'})${p.planPath ? `: ${p.planPath}` : ''}`);
    for (const k of keys) {
      // The plan is applied only on approval: its tasks come from the entry, not from the tasks table.
      const t = p.tasks?.find(x => x.key === k) ?? tasks.getByKey(this.o.db, e.missionId, k);
      const deps = t && t.dependsOn.length > 0 ? t.dependsOn.join(', ') : 'none';
      const owns = t && t.owns.length > 0 ? t.owns.join(', ') : '-';
      this.o.out(`   ${k}  ${t?.title ?? ''}  [${t?.agent ?? '?'}]  depends on: ${deps}  owns: ${owns}`);
    }
    waves.forEach((w, i) => this.o.out(`   Wave ${i + 1}: ${w.join(', ')}`));
    if (p.criticalPath && p.criticalPath.length > 0) this.o.out(`   Critical path: ${p.criticalPath.join(' -> ')}`);
    if (p.cancelled && p.cancelled.length > 0) this.o.out(`   Cancelled by this plan: ${p.cancelled.join(', ')}`);
    if (p.runningUnplanned && p.runningUnplanned.length > 0) {
      this.o.out(`   Running but not in this plan: ${p.runningUnplanned.join(', ')}`);
    }
    for (;;) {
      const a = await this.ask(e.id, 'Approve? [y] approve, or type a note to re-plan:', 'type y, or a note for the conductor',
        l => (l ? l : undefined));
      if (a === GONE) return;
      if (APPROVE_WORDS.includes(a.toLowerCase())) {
        this.o.engine.approvePlan(e.missionId);
        this.o.out('  Plan approved.');
        return;
      }
      // Anything else could be a typo of "yes": confirm before it goes to the conductor as a note.
      const send = await this.ask(e.id, 'Send this as a re-plan note? (y/n)', 'type y or n',
        l => (['y', 'n'].includes(l.toLowerCase()) ? l.toLowerCase() : undefined));
      if (send === GONE) return;
      if (send === 'n') continue;
      this.o.engine.replan(e.missionId, a);
      this.o.out('  Sent back to the conductor for a re-plan.');
      return;
    }
  }

  private async merge(n: number, e: InboxEntry): Promise<void> {
    const p = e.payload as { summary?: string; baseBranch?: string; missionBranch?: string; message?: string };
    this.o.out(`#${n} Mission finished — merge decision`);
    if (p.summary) for (const l of p.summary.split(/\r?\n/)) this.o.out(`   ${l}`);
    if (p.message) this.o.out(`   Note: ${p.message}`);
    const a = await this.ask(e.id, `[m] Merge ${p.missionBranch ?? 'the mission branch'} into ${p.baseBranch ?? 'the base branch'}, [k] ${KEEP}:`,
      'type m or k', l => (['m', 'k'].includes(l.toLowerCase()) ? l.toLowerCase() : undefined));
    if (a === GONE) return;
    if (a === 'm') this.o.out('  Merging…');
    const r = await this.o.engine.answerMergeDecision(e.id, a === 'm' ? MERGE : KEEP);
    if (r.outcome === 'retry') this.o.out(`  The merge did not happen: ${r.reason}`);
    else if (r.outcome === 'stopped') this.o.out('  The mission was stopped before the merge.');
    else this.o.out(r.outcome === 'merged' ? '  Merged.' : `  Kept the branch ${p.missionBranch ?? ''}.`);
  }
}
