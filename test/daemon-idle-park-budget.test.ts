import { describe, expect, it } from 'vitest';
import {
  IDLE_BACKOFF_BASE_MS,
  IDLE_BACKOFF_MAX_MS,
  OWNERSHIP_POLL_MS,
  idleParkMs,
  idleTicksInWindow,
} from '../src/core/daemon/idle-park.js';

const HOUR_MS = 60 * 60_000;

describe('resident idle park budget', () => {
  it('runs at least 5x fewer idle ticks per hour than the fixed 5 s park', () => {
    const fixed = idleTicksInWindow(HOUR_MS, () => IDLE_BACKOFF_BASE_MS);
    const backedOff = idleTicksInWindow(HOUR_MS, (n) => idleParkMs(IDLE_BACKOFF_BASE_MS, n, IDLE_BACKOFF_MAX_MS));
    expect(fixed).toBe(720);
    expect(backedOff * 5).toBeLessThanOrEqual(fixed);
    // Same budget with a realistic 2 s idle tick on a large fleet home.
    const fixedSlow = idleTicksInWindow(HOUR_MS, () => IDLE_BACKOFF_BASE_MS, 2_000);
    const backedOffSlow = idleTicksInWindow(HOUR_MS, (n) => idleParkMs(IDLE_BACKOFF_BASE_MS, n), 2_000);
    expect(backedOffSlow * 5).toBeLessThanOrEqual(fixedSlow);
  });

  it('doubles from the configured base to the ceiling', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => idleParkMs(5_000, n, 60_000)))
      .toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it('keeps a fixed park when the ceiling equals the base, and never parks under the base', () => {
    expect([1, 2, 9].map((n) => idleParkMs(13, n, 13))).toEqual([13, 13, 13]);
    expect(idleParkMs(90_000, 4, 60_000)).toBe(90_000);
  });

  it('falls back to defaults for unusable inputs', () => {
    expect(idleParkMs(Number.NaN, 1, Number.NaN)).toBe(IDLE_BACKOFF_BASE_MS);
    expect(idleParkMs(-1, 99, 0)).toBe(IDLE_BACKOFF_MAX_MS);
    expect(idleParkMs(5_000, 0)).toBe(5_000);
  });

  it('re-reads lock ownership at most once a second', () => {
    expect(OWNERSHIP_POLL_MS).toBeGreaterThanOrEqual(1_000);
  });
});
