import { describe, expect, it } from 'vitest';
import {
  buildGrokUltraRunway,
  GROK_ULTRA_MAX_READINGS,
  GROK_ULTRA_SAMPLE_MS,
  GROK_ULTRA_TARGET,
  validGrokUltraReading,
} from '../src/core/fleet/grok-ultra-runway.js';
import type { GrokUltraReading } from '../src/core/fleet/grok-ultra-types.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const HOUR = 3_600_000;
function reading(hoursAgo: number, remainingPoints: number, patch: Partial<GrokUltraReading> = {}): GrokUltraReading {
  return { source: 'manual', timestamp: new Date(NOW - hoursAgo * HOUR).toISOString(),
    remainingPoints, totalPoints: 10_000, ...patch };
}
const UNKNOWN = { h1: null, h6: null, h24: null };

describe('Grok Ultra full-window runway', () => {
  it('requires a manual reading without inventing zero usage or a source', () => {
    expect(buildGrokUltraRunway([], NOW)).toEqual({
      v: 1, state: 'manual-required', checkedAt: new Date(NOW).toISOString(), targetAt: GROK_ULTRA_TARGET,
      collection: { mode: 'manual', reason: 'safe-local-source-unavailable' }, latest: null,
      burnPointsPerHour: UNKNOWN, projectedRemainingPoints: UNKNOWN, idealPointsPerHour: null,
    });
  });

  it('computes distinct 1, 6 and 24 hour averages from actual point differences', () => {
    const history = [reading(24, 800), reading(6, 500), reading(1, 200), reading(0, 100)];
    const value = buildGrokUltraRunway(history, NOW);
    expect(value.state).toBe('current');
    expect(value.latest).toEqual(history.at(-1));
    expect(value.latest).not.toBe(history.at(-1));
    expect(value.burnPointsPerHour).toEqual({ h1: 100, h6: 400 / 6, h24: 700 / 24 });
    const hoursLeft = (Date.parse(GROK_ULTRA_TARGET) - NOW) / HOUR;
    expect(value.projectedRemainingPoints.h1).toBeCloseTo(100 - 100 * hoursLeft);
    expect(value.projectedRemainingPoints.h6).toBeCloseTo(100 - 400 / 6 * hoursLeft);
    expect(value.projectedRemainingPoints.h24).toBeCloseTo(100 - 700 / 24 * hoursLeft);
    expect(value.projectedRemainingPoints.h1).toBeLessThan(0);
    expect(value.idealPointsPerHour).toBeCloseTo(100 / hoursLeft);
  });

  it('interpolates the balance at a window boundary without pretending sparse readings were refreshed', () => {
    const value = buildGrokUltraRunway([reading(2, 200), reading(0.5, 110), reading(0, 100)], NOW);
    // Balance one hour ago = 140 points, at the linear boundary of 200 -> 110.
    expect(value.burnPointsPerHour).toEqual({ h1: 40, h6: null, h24: null });
    expect(value.latest?.timestamp).toBe(new Date(NOW).toISOString());
  });

  it('withholds each insufficient window independently', () => {
    expect(buildGrokUltraRunway([reading(0, 500)], NOW).burnPointsPerHour).toEqual(UNKNOWN);
    expect(buildGrokUltraRunway([reading(0.5, 600), reading(0, 500)], NOW).burnPointsPerHour).toEqual(UNKNOWN);
    const measured = buildGrokUltraRunway([reading(6, 600), reading(0, 500)], NOW).burnPointsPerHour;
    expect(measured.h1).toBeCloseTo(100 / 6);
    expect(measured.h6).toBeCloseTo(100 / 6);
    expect(measured.h24).toBeNull();
  });

  it('retains measured zero burn and a zero balance instead of treating them as absent', () => {
    const value = buildGrokUltraRunway([reading(24, 0), reading(0, 0)], NOW);
    expect(value.burnPointsPerHour).toEqual({ h1: 0, h6: 0, h24: 0 });
    expect(value.projectedRemainingPoints).toEqual({ h1: 0, h6: 0, h24: 0 });
    expect(value.idealPointsPerHour).toBe(0);
  });

  it('uses the observation time for the forecast and preserves the actual timestamp', () => {
    const latestAt = NOW - GROK_ULTRA_SAMPLE_MS;
    const value = buildGrokUltraRunway([reading(1 + 1 / 6, 200), reading(1 / 6, 100)], NOW);
    const hoursLeft = (Date.parse(GROK_ULTRA_TARGET) - latestAt) / HOUR;
    expect(value.burnPointsPerHour.h1).toBe(100);
    expect(value.projectedRemainingPoints.h1).toBeCloseTo(100 - 100 * hoursLeft);
    expect(value.latest?.timestamp).toBe(new Date(latestAt).toISOString());
    expect(value.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it('marks stale readings and withholds all rates and projections after two sampling intervals', () => {
    const history = [reading(24, 200), reading(0, 100)];
    expect(buildGrokUltraRunway(history, NOW + 2 * GROK_ULTRA_SAMPLE_MS).state).toBe('current');
    const value = buildGrokUltraRunway(history, NOW + 2 * GROK_ULTRA_SAMPLE_MS + 1);
    expect(value.state).toBe('stale');
    expect(value.latest).toEqual(history.at(-1));
    expect(value.burnPointsPerHour).toEqual(UNKNOWN);
    expect(value.projectedRemainingPoints).toEqual(UNKNOWN);
    expect(value.idealPointsPerHour).toBeNull();
  });

  it.each([
    ['future', [reading(-0.1, 100)]],
    ['duplicate timestamp', [reading(0, 200), reading(0, 100)]],
    ['reverse order', [reading(0, 100), reading(1, 200)]],
    ['invalid numeric row', [reading(1, NaN), reading(0, 100)]],
    ['unknown row fields', [{ ...reading(0, 100), account: 'private-fixture' }]],
  ])('rejects %s history as unavailable without disclosing a partial latest value', (_name, history) => {
    const value = buildGrokUltraRunway(history as GrokUltraReading[], NOW);
    expect(value.state).toBe('unavailable');
    expect(value.latest).toBeNull();
    expect(value.burnPointsPerHour).toEqual(UNKNOWN);
    expect(value.projectedRemainingPoints).toEqual(UNKNOWN);
    expect(JSON.stringify(value)).not.toContain('private-fixture');
  });

  it('rejects oversized histories rather than silently trimming away validation evidence', () => {
    expect(buildGrokUltraRunway(Array.from({ length: GROK_ULTRA_MAX_READINGS + 1 }, () => reading(0, 1)), NOW).state)
      .toBe('unavailable');
  });

  it.each([
    ['balance replenishment', reading(2, 100)],
    ['capacity change', reading(2, 600, { totalPoints: 20_000 })],
    ['source change', reading(2, 600, { source: 'app-local' })],
  ])('does not interpolate across a %s', (_name, prior) => {
    const value = buildGrokUltraRunway([prior, reading(0.5, 500), reading(0, 400)], NOW);
    expect(value.burnPointsPerHour).toEqual(UNKNOWN);
    expect(value.projectedRemainingPoints).toEqual(UNKNOWN);
  });

  it('resumes calculation within the new segment once that segment has enough history', () => {
    const value = buildGrokUltraRunway([reading(24, 200), reading(2, 1_000), reading(1, 900), reading(0, 800)], NOW);
    expect(value.burnPointsPerHour).toEqual({ h1: 100, h6: null, h24: null });
  });

  it('pins Sun Nov 1 at 8:21 PM in New York after daylight saving time ends', () => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
      weekday: 'short', month: 'numeric', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(GROK_ULTRA_TARGET));
    const fields = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    expect(fields).toMatchObject({ weekday: 'Sun', month: '11', day: '1', year: '2026',
      hour: '20', minute: '21', timeZoneName: 'GMT-5' });
  });

  it.each([0, 1])('withholds a forward-looking landing once target is reached (+%s ms)', (delta) => {
    const now = Date.parse(GROK_ULTRA_TARGET) + delta;
    const latest: GrokUltraReading = { ...reading(0, 100), timestamp: new Date(now).toISOString() };
    const prior: GrokUltraReading = { ...latest, remainingPoints: 200, timestamp: new Date(now - HOUR).toISOString() };
    const value = buildGrokUltraRunway([prior, latest], now);
    expect(value.burnPointsPerHour.h1).toBe(100);
    expect(value.projectedRemainingPoints).toEqual(UNKNOWN);
    expect(value.idealPointsPerHour).toBeNull();
  });

  it('withholds an overflowing ideal rate while retaining a valid finite point balance', () => {
    const now = Date.parse(GROK_ULTRA_TARGET) - 1;
    const latest: GrokUltraReading = { source: 'manual', timestamp: new Date(now).toISOString(),
      remainingPoints: Number.MAX_VALUE, totalPoints: Number.MAX_VALUE };
    expect(validGrokUltraReading(latest)).toBe(true);
    const value = buildGrokUltraRunway([latest], now);
    expect(value.state).toBe('current');
    expect(value.latest?.remainingPoints).toBe(Number.MAX_VALUE);
    expect(value.idealPointsPerHour).toBeNull();
    expect(value.projectedRemainingPoints).toEqual(UNKNOWN);
  });
});

describe('Grok Ultra reading allowlist', () => {
  it('accepts finite decimal points and both supported provenance values', () => {
    expect(validGrokUltraReading(reading(0, 10.25))).toBe(true);
    expect(validGrokUltraReading(reading(0, 0, { source: 'app-local' }))).toBe(true);
  });

  it.each([
    null, [], '100', {},
    { ...reading(0, 10), source: 'browser' },
    { ...reading(0, 10), remainingPoints: '10' },
    reading(0, -1), reading(0, Infinity), reading(0, NaN), reading(0, 10_001),
    reading(0, 0, { totalPoints: 0 }), reading(0, 1, { totalPoints: Infinity }),
    reading(0, 1, { timestamp: '2026-10-26T12:00:00Z' }),
    reading(0, 1, { timestamp: 'invalid' }),
    { ...reading(0, 10), token: 'private-fixture' },
  ])('rejects malformed or non-usage data %#', (value) => {
    expect(validGrokUltraReading(value)).toBe(false);
  });
});
