import { describe, expect, it } from 'vitest';
import { budgetEntryQuota, DEFAULT_MAX_AGE_MS } from '../src/core/fabric/lane-usage-self.js';

const now = Date.parse('2026-11-11T04:00:00.000Z');
const ttl = 2 * DEFAULT_MAX_AGE_MS;
const at = (offset: number) => new Date(now + offset).toISOString();

describe('budgetEntryQuota freshness', () => {
  it.each([false, true])('applies the same TTL to estimated=%s entries', (estimated) => {
    const entry = { weekly_used_pct: 42, as_of: at(-1000), estimated, reset_at: '2026-11-18T00:00:00.000Z', source: 'fake' };
    expect(budgetEntryQuota(entry, now)).toEqual({ value: { usedPercent: 42 }, asOf: entry.as_of, ttlMs: ttl });
    expect(budgetEntryQuota({ ...entry, as_of: at(-ttl) }, now).value).toEqual({ usedPercent: 42 });
    const expired = { ...entry, as_of: at(-ttl - 1) };
    expect(budgetEntryQuota(expired, now)).toEqual({ value: null, asOf: expired.as_of, ttlMs: ttl });
    const old = { ...entry, as_of: '2020-01-01T00:00:00.000Z' };
    expect(budgetEntryQuota(old, now)).toEqual({ value: null, asOf: old.as_of, ttlMs: ttl });
    expect(budgetEntryQuota({ ...entry, as_of: at(-5000) }, now, 5000).value).toEqual({ usedPercent: 42 });
    expect(budgetEntryQuota({ ...entry, as_of: at(-5001) }, now, 5000)).toEqual({ value: null, asOf: at(-5001), ttlMs: 5000 });
  });

  it('preserves timestamp validation and allowed future skew', () => {
    expect(budgetEntryQuota({ as_of: 'invalid', weekly_used_pct: 50 }, now)).toEqual({ value: null, asOf: null, ttlMs: ttl });
    expect(budgetEntryQuota({ as_of: at(60_001), weekly_used_pct: 50 }, now)).toEqual({ value: null, asOf: at(60_001), ttlMs: ttl });
    expect(budgetEntryQuota({ as_of: at(60_000), weekly_used_pct: 50 }, now).value).toEqual({ usedPercent: 50 });
  });

  it('accepts endpoint percentages and rejects missing or invalid percentages', () => {
    for (const pct of [0, 100]) {
      expect(budgetEntryQuota({ as_of: at(0), weekly_used_pct: pct }, now).value).toEqual({ usedPercent: pct });
    }
    for (const pct of [null, -1, 101, NaN]) {
      expect(budgetEntryQuota({ as_of: at(0), weekly_used_pct: pct }, now)).toEqual({ value: null, asOf: at(0), ttlMs: ttl });
    }
    expect(budgetEntryQuota(null, now)).toEqual({ value: null, asOf: null, ttlMs: ttl });
  });
});
