/** Racy-timestamp settle window (src/core/util/stable-file-read.ts). Pure; no filesystem. */
import { describe, expect, it } from 'vitest';
import {
  ctimeSettleDelayMs,
  sleepSync,
  SUBSECOND_SETTLE_MS,
  WHOLE_SECOND_SETTLE_MS,
} from '../src/core/util/stable-file-read.js';

const ns = (ms: number, extraNs = 0n): bigint => BigInt(ms) * 1_000_000n + extraNs;
const NOW = 1_790_000_000_123;

describe('ctimeSettleDelayMs', () => {
  it('waits out one coarse tick after a sub-second ctime', () => {
    expect(ctimeSettleDelayMs(ns(NOW, 456n), NOW)).toBe(SUBSECOND_SETTLE_MS);
    expect(ctimeSettleDelayMs(ns(NOW - 15, 456n), NOW)).toBe(SUBSECOND_SETTLE_MS - 15);
    expect(ctimeSettleDelayMs(ns(NOW - SUBSECOND_SETTLE_MS, 456n), NOW)).toBe(0);
    expect(ctimeSettleDelayMs(ns(NOW - 60_000, 456n), NOW)).toBe(0);
  });

  it('treats a whole-second ctime as a whole-second filesystem', () => {
    const second = 1_790_000_000_000;
    expect(ctimeSettleDelayMs(ns(second), second + 500)).toBe(WHOLE_SECOND_SETTLE_MS - 500);
    expect(ctimeSettleDelayMs(ns(second), second + WHOLE_SECOND_SETTLE_MS)).toBe(0);
  });

  it('does not wait on a ctime ahead of the clock', () => {
    expect(ctimeSettleDelayMs(ns(NOW + 5, 1n), NOW)).toBe(0);
  });
});

describe('sleepSync', () => {
  it('blocks for real time and ignores non-positive delays', () => {
    expect(() => { sleepSync(0); sleepSync(-5); }).not.toThrow();
    const started = performance.now();
    sleepSync(10);
    expect(performance.now() - started).toBeGreaterThanOrEqual(9);
  });
});
