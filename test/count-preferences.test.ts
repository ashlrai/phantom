/**
 * count-preferences — happy path + one edge case each.
 * No modifications to source; tests only.
 */

import { describe, it, expect } from 'vitest';
import { resolveCountPreference, resolveDaemonCountPreferences, countForInventory } from '../src/core/daemon/count-preferences.js';
import type { DaemonConfig } from '../src/core/types.js';

/* ------------------------------------------------------------------ */
/*  resolveCountPreference: valid positive integer passes through;      */
/*  any other value returns fallback (null fallback is respected).     */
/* ------------------------------------------------------------------ */

describe('resolveCountPreference', () => {
  it('returns valid positive integers unchanged', () => {
    expect(resolveCountPreference(42, 8)).toBe(42);
    expect(resolveCountPreference(1, 3)).toBe(1);
  });

  it('falls back when value is invalid (edge: null explicit)', () => {
    expect(resolveCountPreference(null, 5)).toBeNull();
    expect(resolveCountPreference(undefined, 5)).toBe(5);
    expect(resolveCountPreference('hi', 5)).toBe(5);
    expect(resolveCountPreference(-1, 5)).toBe(5);
    expect(resolveCountPreference(0, 5)).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/*  resolveDaemonCountPreferences: defaults when empty;                 */
/*  explicit numeric overrides; explicit null overrides total.         */
/* ------------------------------------------------------------------ */

describe('resolveDaemonCountPreferences', () => {
  it('returns sensible defaults when raw is empty', () => {
    const cfg = {} as Partial<DaemonConfig>;
    const result = resolveDaemonCountPreferences(cfg);
    expect(result.perTickItems).toBe(1);
    expect(result.parallel).toBe(1);
    expect(result.maxConcurrent).toBe(1);
    expect(result.concurrency.local).toBe(1);
    expect(result.concurrency.cloud).toBe(1);
    expect(result.concurrency.total).toBe(1);
  });

  it('honours explicit numeric overrides and null ceilings (edge: null overrides total)', () => {
    const cfg: Partial<DaemonConfig> = {
      concurrency: { total: 16, local: 4, cloud: 12 },
      perTickItems: 5,
      parallel: 3,
      maxConcurrent: null,
    };
    const result = resolveDaemonCountPreferences(cfg);
    expect(result.perTickItems).toBe(5);
    expect(result.parallel).toBe(3);
    expect(result.maxConcurrent).toBeNull(); // explicit null stays null
    expect(result.concurrency.local).toBe(4);
    expect(result.concurrency.cloud).toBe(12);
    expect(result.concurrency.total).toBe(16);
  });
});

/* ------------------------------------------------------------------ */
/*  countForInventory: caps preference, falls back to available,       */
/*  and handles null preference (happy); invalid inventory returns 0   */
/*  (edge).                                                           */
/* ------------------------------------------------------------------ */

describe('countForInventory', () => {
  it('caps preference below available inventory (happy)', () => {
    expect(countForInventory(4, 10)).toBe(4);
  });

  it('falls back to available when preference exceeds inventory (edge)', () => {
    expect(countForInventory(20, 8)).toBe(8);
  });

  it('uses available when preference is null (happy)', () => {
    expect(countForInventory(null, 12)).toBe(12);
  });

  it('returns 0 for invalid inventory', () => {
    expect(countForInventory(5, -1)).toBe(0);
    expect(countForInventory(5, 0)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Zero-paid lanes (Grok, Cursor) never steer the adaptive ramp on    */
/*  paid or unproven windows; restart and concurrent ticks stay sound. */
/* ------------------------------------------------------------------ */

import {
  ADAPTIVE_START_LEVEL, ZERO_PAID_LANES, countsForThroughput, currentThroughputLevel,
  nextThroughputLevel, noteThroughputSample, resetAdaptiveThroughput, type ThroughputWindow,
} from '../src/core/daemon/count-preferences.js';

const win = (lane: string, headroom: number | null, paid?: boolean): ThroughputWindow =>
  ({ lane, status: 'fresh', headroom, ...(paid === undefined ? {} : { paid }) });

describe('zero-paid lanes and the adaptive ramp', () => {
  it('names Grok and Cursor and leaves other lanes alone', () => {
    expect([...ZERO_PAID_LANES].sort()).toEqual(['cursor', 'grok']);
    expect(countsForThroughput(win('claude', 5))).toBe(true);
    expect(countsForThroughput(win('codex-cmp', 0))).toBe(true);
    expect(countsForThroughput(win('devin', 5))).toBe(false);
  });

  it('ignores paid, credit and unproven Grok/Cursor windows', () => {
    for (const lane of ['grok', 'cursor']) {
      expect(countsForThroughput(win(lane, 9, true))).toBe(false);
      expect(countsForThroughput(win(lane, 9))).toBe(false);
      expect(countsForThroughput(win(lane, 9, false))).toBe(true);
      expect(countsForThroughput({ ...win(lane, 9, false), status: 'unknown' })).toBe(false);
    }
    const prev = { level: 3, measuredLimit: 4 };
    const held = nextThroughputLevel(prev, { windows: [win('grok', 50, true), win('cursor', 50)] });
    expect(held).toEqual({ level: 3, measuredLimit: 4, rule: 'hold' });
    // A paid zero window is not a block either.
    expect(nextThroughputLevel(prev, { windows: [win('cursor', 0, true)] }).rule).toBe('hold');
  });

  it('still ramps and backs off on subscription windows for these lanes', () => {
    expect(nextThroughputLevel({ level: 2, measuredLimit: 5 }, { windows: [win('grok', 3, false)] }))
      .toEqual({ level: 3, measuredLimit: null, rule: 'ramp' });
    expect(nextThroughputLevel({ level: 4, measuredLimit: null }, { windows: [win('cursor', 0, false)] }))
      .toEqual({ level: 3, measuredLimit: 4, rule: 'back-off' });
  });

  it('keeps other lanes ramping when a paid Grok window is present', () => {
    const next = nextThroughputLevel({ level: 2, measuredLimit: 6 }, { windows: [win('grok', 0, true), win('claude', 4)] });
    expect(next.rule).toBe('ramp');
    expect(next.level).toBe(3);
  });

  it('restarts at the first step and applies the same rule afterwards', () => {
    resetAdaptiveThroughput();
    for (let i = 0; i < 4; i++) noteThroughputSample({ windows: [win('claude', 2)] });
    expect(currentThroughputLevel().level).toBe(ADAPTIVE_START_LEVEL + 4);
    resetAdaptiveThroughput(); // process restart
    expect(currentThroughputLevel()).toEqual({ level: ADAPTIVE_START_LEVEL, measuredLimit: null });
    // After restart a paid Grok window cannot ramp: nothing steers, so a null limit still ramps by the
    // default rule, but the sample is not counted as room; the measured limit is honoured.
    noteThroughputSample({ saturated: true });
    const after = noteThroughputSample({ windows: [win('grok', 8, true), win('cursor', 8)] });
    expect(after.rule).toBe('hold');
    expect(currentThroughputLevel().level).toBeLessThanOrEqual(currentThroughputLevel().measuredLimit!);
    resetAdaptiveThroughput();
  });

  it('gives the same level for concurrent mixed samples in any order', async () => {
    const samples = [
      { windows: [win('grok', 9, true)] }, { windows: [win('claude', 2)] },
      { windows: [win('cursor', 9)] }, { windows: [win('grok', 9, false)] },
    ];
    const run = async (order: number[]) => {
      resetAdaptiveThroughput();
      await Promise.all(order.map(async (i) => { await Promise.resolve(); noteThroughputSample(samples[i]!); }));
      return currentThroughputLevel();
    };
    const a = await run([0, 1, 2, 3]);
    const b = await run([3, 2, 1, 0]);
    // Only the claude and subscription-grok samples ramp; paid/unproven ones add nothing on their own
    // (they fall through to the unmeasured default ramp), so both orders agree.
    expect(a).toEqual(b);
    resetAdaptiveThroughput();
  });
});
