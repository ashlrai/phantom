import { expect, it } from 'vitest';
import type { ResourceLaneRow } from '../usage/fleet-ledger-model.js';
import { wasteForecast } from './waste-forecast-model.js';
import { wasteRow } from './waste-row-model.js';

const now = Date.parse('2026-10-31T23:30:00Z');
const iso = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const lane = (overrides: Partial<ResourceLaneRow>): ResourceLaneRow => ({
  lane: 'codex-personal', running: 2, target: 2, held: false, window: 'weekly', usedPct: 40,
  creditsRemaining: null, resetAt: iso(42), burnPctPerHour: 0.5, tokensPerHour6h: null,
  projectedExhaustion: null, source: null, ...overrides,
});
const row = (overrides: Partial<ResourceLaneRow>) => {
  const data = lane(overrides);
  return wasteRow(wasteForecast(data, now)!, data, now);
};

it('splits a measured window into used, more by the reset and unused, with the time gone', () => {
  // 42 h left of 168: 75% gone. 40% used + 0.5%/h for 42 h = 21 more, 39 unused.
  expect(row({})).toMatchObject({
    lane: 'codex-personal', tone: 'warn', verdict: 'Watch', figure: '39% unused at reset',
    used: 40, more: 21, unused: 39, elapsed: 75,
    valueText: '40% used, 21% more by reset at the current burn, 39% unused; 75% of the window gone',
  });
  expect(row({}).facts.slice(1)).toEqual([
    'needs 1.4%/h to use it all', 'burning 0.5%/h', '75% of the window gone, use is 35 points behind an even spend',
  ]);
  expect(row({}).facts[0]).toMatch(/^resets /);
});

it('projects nothing without a measured burn: the figure is an upper bound and only the used share is drawn', () => {
  const unknown = row({ burnPctPerHour: null });
  expect(unknown).toMatchObject({
    figure: 'up to 60% unused at reset', tone: 'bad', verdict: 'High', used: 40, more: null, unused: null, elapsed: 75,
    valueText: '40% used, burn unknown, up to 60% unused; 75% of the window gone',
  });
  expect(unknown.facts).toContain('burning unknown');
});

it('leaves the time mark off a reset more than seven days out', () => {
  const far = row({ resetAt: iso(200) });
  expect(far.elapsed).toBeNull();
  expect(far.valueText).not.toContain('window gone');
  expect(far.facts.some(fact => fact.includes('window gone'))).toBe(false);
});

it('says a window on track needs nothing, and names a hold', () => {
  const onTrack = row({ usedPct: 90, resetAt: iso(9), burnPctPerHour: 2 });
  expect(onTrack).toMatchObject({ tone: 'ok', verdict: 'On track', figure: '0% unused at reset', used: 90, more: 10, unused: 0 });
  expect(onTrack.facts).toEqual(['resets in 9 h', 'burning 2%/h', '95% of the window gone, use is 5 points behind an even spend']);
  expect(row({ held: true, burnPctPerHour: 0, resetAt: iso(9) }).facts.at(-1)).toBe('held, nothing will burn');
});

it('draws no share for a reading that is not a number', () => {
  const data = lane({ usedPct: Number.NaN });
  const forecast = wasteForecast(lane({}), now)!;
  expect(wasteRow(forecast, data, now)).toMatchObject({ used: null, more: null, unused: null, valueText: 'usage unknown' });
});
