import { describe, expect, it } from 'vitest';
import { effectivePoolReading, type PoolReading } from '../src/core/fleet/pool-reading.js';

const RESET = '2026-11-20T23:00:00.000Z';
const NOW = Date.parse('2026-11-20T23:48:00.000Z');
const old: PoolReading = { used_pct: 100, observed_at: '2026-11-20T22:38:00.000Z', reset_at: RESET };

describe('effectivePoolReading', () => {
  it('counts a pool as refilled when the reset passed after the reading', () => {
    expect(effectivePoolReading(old, [], NOW)).toEqual({ used_pct: 0, observed_at: null, state: 'refilled', basis: `reset passed at ${RESET}` });
  });
  it('ignores sensor readings from before the reset', () => {
    const before = [{ used_pct: 99, observed_at: '2026-11-20T22:50:00.000Z' }];
    expect(effectivePoolReading(old, before, NOW).state).toBe('refilled');
  });
  it('lets a newer sensor reading win', () => {
    const sensors = [{ used_pct: 5, observed_at: '2026-11-20T23:30:00.000Z' }, { used_pct: 2, observed_at: '2026-11-20T23:10:00.000Z' }];
    expect(effectivePoolReading(old, sensors, NOW)).toMatchObject({ used_pct: 5, state: 'measured' });
  });
  it('ignores sensor readings dated in the future', () => {
    expect(effectivePoolReading(old, [{ used_pct: 5, observed_at: '2026-11-21T00:00:00.000Z' }], NOW).state).toBe('refilled');
  });
  it('leaves the reading alone while the reset is still ahead', () => {
    const reading = { ...old, reset_at: '2026-11-21T23:00:00.000Z' };
    expect(effectivePoolReading(reading, [], NOW)).toEqual({ used_pct: 100, observed_at: old.observed_at, state: 'measured', basis: null });
  });
  it('leaves the reading alone when no reset time is known', () => {
    expect(effectivePoolReading({ ...old, reset_at: null }, [], NOW)).toMatchObject({ used_pct: 100, state: 'measured' });
  });
  it('keeps a reading taken after the reset', () => {
    expect(effectivePoolReading({ ...old, observed_at: '2026-11-20T23:20:00.000Z', used_pct: 4 }, [], NOW)).toMatchObject({ used_pct: 4, state: 'measured' });
  });
  it('keeps unknown unknown, even past a reset', () => {
    expect(effectivePoolReading({ ...old, used_pct: null }, [], NOW)).toMatchObject({ used_pct: null, state: 'unknown' });
  });
});
