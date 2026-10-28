// Global start throttle (spec §8.2): after a rate-limit event whose status is not `allowed`, new task starts pause
// until `resetsAt`, or, without one, for an exponential backoff of 1, 2, 4 ... minutes (capped at 30).
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
    if (ev.resetsAt !== null && Number.isFinite(ev.resetsAt)) this.until = ev.resetsAt * 1000; // resetsAt is in seconds
    else this.onRateLimitedWithoutReset(now);
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
