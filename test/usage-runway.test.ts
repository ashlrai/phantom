import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetUsageHistory } from '../src/cli/fleet-usage-history.js';
import { poolUsageSeries, usageHistoryText, usageRunway, type UsageHistoryV1, type UsagePoint, type UsageReading } from '../src/core/fleet/usage-history.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const H = 3_600_000;
const iso = (t: number): string => new Date(t).toISOString();
const at = (hoursAgo: number, used: number): UsagePoint => ({ at: iso(NOW - hoursAgo * H), used_pct: used });
const RESET = iso(NOW + 45 * H);

afterEach(() => vi.restoreAllMocks());

describe('usageRunway', () => {
  it('runs dry early: 15% then 23% in 105 minutes is 4.6 points per hour', () => {
    const r = usageRunway('claude', [at(2.75, 15), at(1, 23)], RESET, NOW);
    expect(r).toMatchObject({ verdict: 'runs dry early', pace_per_hour: 4.57, runway_hours: 16.8, hours_to_reset: 45, hours_early: 28.2, target_pace_per_hour: 1.71 });
    expect(r.advice).toBe('slow to 1.71 points per hour');
    expect(r.sentence).toBe('Claude: 23% used, 45 h to reset, running dry 28 h early at this pace; slow to 1.71 points per hour');
  });

  it('on pace when the pace finishes at the reset', () => {
    // 77 points left over 45 h is 1.71 per hour.
    const r = usageRunway('claude', [at(2.5, 23 - 2 * 77 / 45), at(0.5, 23)], RESET, NOW);
    expect(r.verdict).toBe('on pace');
    expect(r.advice).toBeNull();
    expect(r.sentence).toBe('Claude: 23% used, 45 h to reset, on pace');
  });

  it('leaves usage unspent when the pace is slow, and says speed up', () => {
    const r = usageRunway('claude', [at(3, 20), at(1, 21)], RESET, NOW);
    expect(r).toMatchObject({ verdict: 'will leave usage unspent', pace_per_hour: 0.5, hours_early: null, unspent_pct: 56.5, target_pace_per_hour: 1.76 });
    expect(r.advice).toBe('speed up to 1.76 points per hour');
  });

  it('is unknown with a single reading', () => {
    expect(usageRunway('claude', [at(1, 23)], RESET, NOW)).toMatchObject({ verdict: 'unknown', pace_per_hour: null, reason: 'only one reading' });
  });

  it('is unknown when the newest reading is stale', () => {
    const r = usageRunway('claude', [at(10, 15), at(5, 23)], RESET, NOW);
    expect(r).toMatchObject({ verdict: 'unknown', pace_per_hour: null, runway_hours: null, reason: 'latest reading is stale' });
  });

  it('restarts the series when used goes down (a reset between readings)', () => {
    const reset = usageRunway('claude', [at(3, 90), at(2, 4), at(1, 8)], RESET, NOW);
    expect(reset).toMatchObject({ verdict: 'runs dry early', pace_per_hour: 4 });
    expect(usageRunway('claude', [at(3, 90), at(1, 4)], RESET, NOW)).toMatchObject({ verdict: 'unknown', reason: 'only one reading' });
  });

  it('ignores a reading taken before the window started', () => {
    const r = usageRunway('claude', [{ at: iso(NOW - 8 * 24 * H), used_pct: 10 }, at(1, 23)], RESET, NOW);
    expect(r).toMatchObject({ verdict: 'unknown', reason: 'only one reading' });
  });

  it('is unknown for two identical readings', () => {
    expect(usageRunway('claude', [at(3, 23), at(1, 23)], RESET, NOW)).toMatchObject({ verdict: 'unknown', pace_per_hour: null, reason: 'readings are identical; no pace yet' });
  });

  it('is unknown without a reset time, or once it passed', () => {
    expect(usageRunway('claude', [at(3, 15), at(1, 23)], null, NOW)).toMatchObject({ verdict: 'unknown', hours_to_reset: null, reason: 'reset time unknown' });
    expect(usageRunway('claude', [at(3, 15), at(1, 23)], iso(NOW - H), NOW)).toMatchObject({ verdict: 'unknown' });
  });

  it('adds a 6 hour pace from oldest to newest with three or more readings', () => {
    const r = usageRunway('claude', [at(5, 10), at(3, 12), at(1, 23)], RESET, NOW);
    expect(r.pace_per_hour).toBe(5.5);
    expect(r.pace_6h_per_hour).toBe(3.25);
    expect(usageRunway('claude', [at(3, 12), at(1, 23)], RESET, NOW).pace_6h_per_hour).toBeNull();
  });

  it('uses the first reading at a flat run\'s value, not the tail', () => {
    expect(usageRunway('claude', [at(3, 15), at(2, 23), at(0.5, 23)], RESET, NOW).pace_per_hour).toBe(8);
  });

  it('withholds runway advice when fresh flat readings follow a stale change', () => {
    const result = usageRunway('claude', [at(5, 15), at(4, 23), at(2, 23), at(0.5, 23)], RESET, NOW);
    expect(result).toMatchObject({
      verdict: 'unknown', pace_per_hour: null, pace_6h_per_hour: null, runway_hours: null,
      hours_to_reset: 45, advice: null, reason: 'latest usage change is stale',
    });
    expect(result.sentence).toContain('23% used');
    expect(usageRunway('claude', [at(4, 15), at(3, 23), at(0.5, 23)], RESET, NOW).pace_per_hour).toBe(8);
  });
});

describe('fleet usage-history output', () => {
  const rows: UsageReading[] = [
    { pool: 'claude', used_pct: 15, observed_at: at(2.75, 0).at, reset_at: RESET, source: 'test' },
    { pool: 'claude', used_pct: 23, observed_at: at(1, 0).at, reset_at: RESET, source: 'test' },
    { pool: 'zai', used_pct: 5, observed_at: at(1, 0).at, reset_at: RESET, source: 'test' },
  ];
  const snapshot = (): UsageHistoryV1 => ({ schema: 'fleet.usage-history.v1', v: 1, generated_at: iso(NOW), source_state: 'healthy',
    pools: ['claude', 'zai'].map(p => poolUsageSeries(p, rows, NOW)) });

  it('puts one plain sentence per pool at the top of the human output', () => {
    const lines = usageHistoryText(snapshot(), NOW);
    expect(lines[0]).toBe('Claude: 23% used, 45 h to reset, running dry 28 h early at this pace; slow to 1.71 points per hour');
    expect(lines[1]).toBe('Zai: 5% used, unknown (only one reading)');
    expect(lines[2]).toBe('');
  });

  it('--json carries the runway fields per pool, with unknown as null', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetUsageHistory(['--json'], async () => snapshot())).toBe(0);
    const out = JSON.parse(String(log.mock.calls[0]![0])) as UsageHistoryV1;
    expect(Object.keys(out.pools[0]!.runway).sort()).toEqual(['advice', 'hours_early', 'hours_to_reset', 'pace_6h_per_hour', 'pace_per_hour',
      'reason', 'runway_hours', 'sentence', 'target_pace_per_hour', 'unspent_pct', 'verdict']);
    expect(out.pools[0]!.runway).toMatchObject({ verdict: 'runs dry early', hours_early: 28.2 });
    expect(out.pools[1]!.runway).toMatchObject({ verdict: 'unknown', pace_per_hour: null, runway_hours: null, reason: 'only one reading' });
  });
});
