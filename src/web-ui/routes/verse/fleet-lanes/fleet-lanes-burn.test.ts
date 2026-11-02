import { describe, expect, it } from 'vitest';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { burnLine, burnTotals, formatTokens, laneBars } from './fleet-lanes-model.js';

describe('lane burn', () => {
  it.each([
    [null, '—'], [NaN, '—'], [Infinity, '—'], [-1, '—'], [0, '0'], [999, '999'],
    [1_000, '1k'], [12_400, '12.4k'], [1_300_000, '1.3M'],
  ])('formats %s tokens as %s', (value, expected) => {
    expect(formatTokens(value)).toBe(expected);
  });

  it('totals reported values independently and preserves lane values', () => {
    const runs = withLane(fleetRunsFixture(), { lane: 'codex-personal', tokensLastHour: 1_300_000, merged24h: 9 });
    expect(laneBars(runs)[0]).toMatchObject({ tokensLastHour: 1_300_000, merged24h: 9 });
    expect(burnTotals(runs)).toEqual({ tokensLastHour: 1_300_000, reportingLanes: 1, merged24h: 14 });
    expect(burnLine(burnTotals(runs))).toBe('1.3M tokens in the last hour across 1 reporting lane');
    const both = withLane(runs, { lane: 'devin', tokensLastHour: 0, merged24h: null });
    expect(burnTotals(both)).toEqual({ tokensLastHour: 1_300_000, reportingLanes: 2, merged24h: 9 });
    expect(burnLine(burnTotals(both))).toBe('1.3M tokens in the last hour across 2 reporting lanes');
  });

  it('reports missing and invalid values as unavailable', () => {
    const runs = fleetRunsFixture({ lanes: [] });
    expect(burnTotals(runs)).toEqual({ tokensLastHour: null, reportingLanes: 0, merged24h: null });
    expect(burnLine(burnTotals(runs))).toBe('No lane reports token burn yet');
    const invalid = withLane(fleetRunsFixture(), { lane: 'codex-personal', tokensLastHour: -1, merged24h: NaN });
    expect(burnTotals(invalid)).toEqual({ tokensLastHour: null, reportingLanes: 0, merged24h: 5 });
  });
});
