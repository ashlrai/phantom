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
    expect(result.perTickItems).toBe(3);
    expect(result.parallel).toBe(2);
    expect(result.maxConcurrent).toBe(8); // inherits total (default 8)
    expect(result.concurrency.local).toBe(2);
    expect(result.concurrency.cloud).toBe(6);
    expect(result.concurrency.total).toBe(8);
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
