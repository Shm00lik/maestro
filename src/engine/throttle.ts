// Global start throttle (spec §8.2): after a rate-limit event whose status is not `allowed` or `allowed_warning`,
// new task starts pause until `resetsAt`, or, without one (or with one in the past), for an exponential backoff of
// 1, 2, 4 ... minutes (capped at 30).
import type { StreamEvent } from '../claude/protocol.js';
import { nextBackoffMs } from '../core/scheduler/scheduler.js';

export type RateLimitEvent = Pick<Extract<StreamEvent, { kind: 'rate-limit' }>, 'status' | 'resetsAt'>;

export class Throttle {
  private until: number | null = null;
  private lastBackoffMs: number | null = null;

  onRateLimit(ev: RateLimitEvent, now: number): void {
    if (ev.status === 'allowed') {
      this.until = null;
      this.lastBackoffMs = null;
      return;
    }
    if (ev.status === 'allowed_warning') return; // still allowed: neither throttles nor clears
    const at = ev.resetsAt !== null && Number.isFinite(ev.resetsAt) ? ev.resetsAt * 1000 : null; // resetsAt is in seconds
    if (at !== null && at > now) this.until = at;
    else this.onRateLimitedWithoutReset(now); // no resetsAt, or one already in the past

  }

  onRateLimitedWithoutReset(now: number): void {
    this.lastBackoffMs = nextBackoffMs(this.lastBackoffMs);
    this.until = now + this.lastBackoffMs;
  }

  /** When new starts may resume, or null when not throttled (or the time has passed). */
  throttledUntil(now: number): number | null {
    return this.until !== null && this.until > now ? this.until : null;
  }
}
