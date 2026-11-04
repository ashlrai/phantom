import { describe, expect, it } from 'vitest';
import { buildLaneCards, formatCountdown, parseFleetUsage, wasteRisk, type FleetUsageLane } from './fleet-usage-model.js';
import { FLEET_USAGE_FIXTURE } from './fleet-usage.fixture.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const lane = (patch: Partial<FleetUsageLane> = {}): FleetUsageLane => ({
  lane: 'claude', window: 'weekly', usedPct: 40, resetAt: new Date(NOW + 10 * 3_600_000).toISOString(), burnPctPerHour: 2,
  running: 1, target: 2, ceiling: 3, queued: 0, held: false, heldReason: null, sourceAgeSec: 30, stale: false, ...patch,
});

describe('wasteRisk', () => {
  it('projects unused capacity at reset', () => expect(wasteRisk(lane(), NOW)).toMatchObject({ level: 'medium', unusedPct: 40 }));
  it('is high at 50 points or more', () => expect(wasteRisk(lane({ burnPctPerHour: 0 }), NOW)).toMatchObject({ level: 'high', unusedPct: 60 }));
  it('is low when burn will consume the window', () => expect(wasteRisk(lane({ burnPctPerHour: 6 }), NOW)).toMatchObject({ level: 'low', unusedPct: 0 }));
  it('treats a held lane as burning nothing', () => expect(wasteRisk(lane({ held: true, burnPctPerHour: 9 }), NOW).unusedPct).toBe(60));
  it.each([
    ['no window', { window: 'none' as const }], ['no usage', { usedPct: null }], ['no reset', { resetAt: null }],
    ['reset passed', { resetAt: new Date(NOW - 1000).toISOString() }], ['no burn', { burnPctPerHour: null }],
  ])('is unknown with %s', (_n, patch) => expect(wasteRisk(lane(patch), NOW)).toMatchObject({ level: 'unknown', unusedPct: null }));
});

describe('buildLaneCards', () => {
  it('sorts the most at-risk lane first and unknown last', () => {
    const feed = parseFleetUsage(FLEET_USAGE_FIXTURE(NOW));
    const cards = buildLaneCards(feed, NOW);
    expect(cards.map(c => c.lane.lane)[0]).toBe('codex-cmp');
    expect(cards.at(-1)!.risk.level).toBe('unknown');
    const known = cards.filter(c => c.risk.unusedPct !== null).map(c => c.risk.unusedPct!);
    expect(known).toEqual([...known].sort((a, b) => b - a));
  });
  it('flags stale by flag, by age, and when the whole feed is old', () => {
    const feed = { schema: 'fleet-usage.v1' as const, generatedAt: new Date(NOW).toISOString(),
      lanes: [lane({ lane: 'a', stale: true }), lane({ lane: 'b', sourceAgeSec: 3600 }), lane({ lane: 'c' })] };
    expect(buildLaneCards(feed, NOW).map(c => [c.lane.lane, c.stale])).toEqual(expect.arrayContaining([['a', true], ['b', true], ['c', false]]));
    expect(buildLaneCards(feed, NOW + 3_600_000).every(c => c.stale)).toBe(true);
  });
});

describe('parseFleetUsage', () => {
  it('rejects a wrong schema', () => expect(() => parseFleetUsage({ schema: 'fleet-usage.v2', lanes: [] })).toThrow(/fleet-usage.v1/));
  it('rejects non-objects', () => expect(() => parseFleetUsage(null)).toThrow());
  it('clamps and nulls bad numbers, skips unnamed lanes', () => {
    const parsed = parseFleetUsage({ schema: 'fleet-usage.v1', generatedAt: 'x', lanes: [{ lane: 'z', usedPct: 140, running: 'two', held: 'yes' }, { usedPct: 1 }] });
    expect(parsed.lanes).toHaveLength(1);
    expect(parsed.lanes[0]).toMatchObject({ usedPct: 100, running: null, held: false, window: 'none' });
  });
});

describe('formatCountdown', () => {
  const from = (ms: number) => new Date(NOW + ms).toISOString();
  it.each([
    [93_784_000, '1d 2h 3m'], [3_725_000, '1h 2m 05s'], [125_000, '2m 05s'], [0, 'Resetting now'], [-5, 'Resetting now'],
  ])('formats %i ms', (ms, text) => expect(formatCountdown(from(ms), NOW)).toBe(text));
  it('handles missing or invalid reset', () => { expect(formatCountdown(null, NOW)).toBe('Reset unknown'); expect(formatCountdown('nope', NOW)).toBe('Reset unknown'); });
});
