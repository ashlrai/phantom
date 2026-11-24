import { describe, expect, it } from 'vitest';
import type { LaneAllowanceRow } from '../../../../core/usage/lane-allowance.js';
import { allowanceBar, barNeedsKey, laneReading } from './lane-allowance-model.js';

const now = Date.parse('2026-12-02T00:00:00.000Z');
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const HOUR = 3_600_000;
const row = (changes: Partial<LaneAllowanceRow> = {}): LaneAllowanceRow => ({ lane: 'claude', label: 'Claude', used: 62, limit: 100,
  left: 38, unit: 'percent', usedPct: 62, resetAt: at(HOUR), resetsInHours: 1, windowStart: null,
  measuredAt: at(-240_000), ageSeconds: 240, freshness: 'live', posture: 'balanced', postureReason: 'fixture',
  costClass: 'included', projectedUnusedPct: null, history: null, reason: null, devin: null, ...changes });
const history = (exhaustAt: string | null, resetAt: string | null = at(HOUR)): LaneAllowanceRow['history'] =>
  ({ points: [], burn: { perHour: 10, from: at(-HOUR), to: at(0) }, exhaustAt, resetAt });
const bar = (changes: Partial<LaneAllowanceRow> = {}) => {
  const value = row(changes);
  return allowanceBar(value, laneReading(value, now), now, iso => `at ${iso}`);
};

describe('lane allowance bar', () => {
  it('draws only the measured share when nothing is projected', () => {
    expect(bar()).toEqual({ used: 62, more: null, unused: null, elapsed: null, ending: 'open', end: null, pace: null, lead: null, words: '62% used' });
    expect(barNeedsKey(bar())).toBe(false);
  });

  it('draws no share at all without a usable reading, even when the row carries a percentage', () => {
    for (const changes of [{ used: null }, { limit: null }, { measuredAt: null }, { measuredAt: at(60_000) }, { freshness: 'invalid-future' as const }]) {
      expect(bar({ usedPct: 0, ...changes })).toMatchObject({ used: null, more: null, unused: null, elapsed: null, ending: 'unknown', words: 'usage unknown' });
    }
  });

  it('splits the rest of the window by the router projection', () => {
    const projected = bar({ posture: 'burn', projectedUnusedPct: 30 });
    expect(projected).toMatchObject({ used: 62, more: 8, unused: 30, ending: 'unused', end: 'About 30% would go unused at the reset, by the router’s projection' });
    expect(projected.words).toBe('62% used. About 30% would go unused at the reset, by the router’s projection');
    expect(barNeedsKey(projected)).toBe(true);
    // A projection larger than what is left cannot be drawn past the end of the bar.
    expect(bar({ posture: 'burn', projectedUnusedPct: 80 })).toMatchObject({ more: 0, unused: 38 });
    expect(bar({ posture: 'balanced', projectedUnusedPct: 0.2 })).toMatchObject({ more: 38, unused: null, ending: 'level' });
  });

  it('ignores a projection the row does not vouch for', () => {
    expect(bar({ posture: 'unknown', projectedUnusedPct: 30 })).toMatchObject({ more: null, unused: null, ending: 'open', end: null });
  });

  it('says the window runs dry when the measured burn ends before the reset', () => {
    const dry = bar({ history: history(at(HOUR / 2)), posture: 'burn', projectedUnusedPct: 30 });
    expect(dry).toMatchObject({ used: 62, more: 38, unused: null, ending: 'dry' });
    expect(dry.end).toBe(`Runs out about at ${at(HOUR / 2)}, before the reset, at the measured burn`);
  });

  it('does not call a window dry from a burn past the reset, a past instant, or another window’s history', () => {
    expect(bar({ history: history(at(2 * HOUR)) }).ending).toBe('open');
    expect(bar({ history: history(at(-HOUR)) }).ending).toBe('open');
    expect(bar({ history: history(at(HOUR / 2), at(5 * HOUR)) }).ending).toBe('open');
    expect(bar({ history: { ...history(at(HOUR / 2))!, burn: null } }).ending).toBe('open');
  });

  it('marks the time gone only from a reported window start', () => {
    const paced = bar({ windowStart: at(-3 * HOUR) });
    expect(paced).toMatchObject({ elapsed: 75, lead: 'behind', pace: '75% of the window gone; use is 13 points behind an even spend' });
    expect(paced.words).toBe('62% used. 75% of the window gone; use is 13 points behind an even spend');
    expect(bar({ windowStart: at(-HOUR / 2) })).toMatchObject({ elapsed: 33.3, lead: 'ahead' });
    expect(bar({ windowStart: at(-HOUR), usedPct: 50 })).toMatchObject({ elapsed: 50, lead: 'level' });
    for (const windowStart of [null, 'not a time', at(2 * HOUR), at(60_000)]) expect(bar({ windowStart })).toMatchObject({ elapsed: null, pace: null, lead: null });
  });

  it('projects nothing from a stale reading or a window that is not open', () => {
    const full = { windowStart: at(-HOUR), posture: 'burn' as const, projectedUnusedPct: 30, history: history(at(HOUR / 2)) };
    expect(bar({ ...full, freshness: 'stale' })).toMatchObject({ used: 62, more: null, unused: null, elapsed: null, ending: 'last', words: '62% used; last reading, now stale' });
    expect(bar({ ...full, resetAt: null })).toMatchObject({ ending: 'last', elapsed: null, words: '62% used; reset unknown' });
    expect(bar({ ...full, resetAt: at(-1) })).toMatchObject({ ending: 'last', more: null, words: '62% used; its recorded reset has passed' });
  });

  it('calls a full allowance spent, not behind or ahead', () => {
    expect(bar({ used: 100, left: 0, usedPct: 100, windowStart: at(-HOUR) })).toMatchObject({ used: 100, ending: 'spent', end: 'All of it is used until the reset', lead: null, pace: '50% of the window gone' });
  });
});
