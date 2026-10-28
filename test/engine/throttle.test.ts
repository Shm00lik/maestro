import { describe, expect, it } from 'vitest';
import { Throttle } from '../../src/engine/throttle.js';

const ev = (status: string, resetsAt: number | null = null) =>
  ({ kind: 'rate-limit' as const, status, resetsAt, fiveHour: null, sevenDay: null });

describe('Throttle', () => {
  it('throttles until resetsAt and falls back to backoff', () => {
    const t = new Throttle();
    const now = 1_800_000_000_000;
    expect(t.throttledUntil(now)).toBeNull();

    // resetsAt is in seconds.
    t.onRateLimit(ev('rejected', 1_800_000_600), now);
    expect(t.throttledUntil(now)).toBe(1_800_000_600_000);
    expect(t.throttledUntil(1_800_000_600_001)).toBeNull(); // past: null

    // 'allowed' clears.
    t.onRateLimit(ev('rejected', 1_800_000_600), now);
    t.onRateLimit(ev('allowed', 1_800_000_600), now);
    expect(t.throttledUntil(now)).toBeNull();

    // No resetsAt: backoff 1, 2, 4 ... minutes, capped at 30.
    t.onRateLimit(ev('rejected'), now);
    expect(t.throttledUntil(now)).toBe(now + 60_000);
    t.onRateLimitedWithoutReset(now);
    expect(t.throttledUntil(now)).toBe(now + 120_000);
    t.onRateLimit(ev('rejected'), now);
    expect(t.throttledUntil(now)).toBe(now + 240_000);
    for (let i = 0; i < 10; i++) t.onRateLimitedWithoutReset(now);
    expect(t.throttledUntil(now)).toBe(now + 1_800_000);

    // 'allowed' also resets the backoff.
    t.onRateLimit(ev('allowed'), now);
    t.onRateLimitedWithoutReset(now);
    expect(t.throttledUntil(now)).toBe(now + 60_000);
  });
});
