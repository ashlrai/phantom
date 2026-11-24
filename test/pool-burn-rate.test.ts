/** Burn rate from real readings, and the pools.v1 verdict built on it. Synthetic readings only. */
import { describe, expect, it } from 'vitest';
import { burnRate, type BurnSample } from '../src/core/usage/burn-rate.js';
import { buildPoolsView, type PoolSample } from '../src/core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const NOW = Date.parse('2026-11-19T09:50:00.000Z');
const RESET = '2026-11-20T23:00:00.000Z';
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const sample = (hoursAgo: number, used: number, reset: string | null = RESET): BurnSample => ({ at: at(hoursAgo), used_pct: used, reset_at: reset });

describe('burnRate', () => {
  it('fits a steady climb within 0.2 points an hour and reports its evidence', () => {
    // 3 points an hour, with small timing wobble in the readings.
    const read = burnRate([sample(3, 50), sample(2, 53), sample(1, 56), sample(0, 59)], NOW);
    expect(read.points_per_hour).toBeGreaterThan(2.8);
    expect(read.points_per_hour).toBeLessThan(3.2);
    expect(read).toMatchObject({ samples: 4, window_h: 3, method: 'least-squares-6h', reason: null });
  });

  it('matches the Claude sensor readings of 19 Nov (59, 64, 67, 70 percent)', () => {
    const t = (h: number, m: number): string => `2026-11-19T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
    const read = burnRate([
      { at: t(6, 48), used_pct: 59 }, { at: t(7, 49), used_pct: 64 }, { at: t(8, 28), used_pct: 67 }, { at: t(9, 48), used_pct: 70 },
    ], NOW);
    expect(Math.abs(read.points_per_hour! - 3.66)).toBeLessThan(0.2);
    expect(read.samples).toBe(4);
  });

  it('ignores readings from before a reset inside the window', () => {
    const read = burnRate([sample(5, 90, '2026-11-13T23:00:00.000Z'), sample(4, 96, '2026-11-13T23:00:00.000Z'),
      sample(3, 2), sample(2, 4), sample(1, 6), sample(0, 8)], NOW);
    expect(read.samples).toBe(4);
    expect(read.points_per_hour).toBeCloseTo(2, 1);
  });

  it('treats a used share that goes down as a reset even when the reset time is unchanged', () => {
    const read = burnRate([sample(4, 80), sample(3, 85), sample(2, 10), sample(1, 12), sample(0, 14)], NOW);
    expect(read.samples).toBe(3);
    expect(read.points_per_hour).toBeCloseTo(2, 1);
  });

  it('needs three readings from the last 6 hours', () => {
    expect(burnRate([sample(1, 50), sample(0, 53)], NOW)).toMatchObject({ points_per_hour: null, samples: 2, reason: '2 readings in the last 6 h, need 3' });
    expect(burnRate([sample(8, 10), sample(7, 20), sample(0, 53)], NOW)).toMatchObject({ points_per_hour: null, samples: 1 });
    expect(burnRate([], NOW)).toMatchObject({ points_per_hour: null, samples: 0, window_h: 0 });
  });

  it('keeps a flat run flat and never goes below zero', () => {
    expect(burnRate([sample(2, 40), sample(1, 40), sample(0, 40)], NOW).points_per_hour).toBe(0);
  });
});

const lane = (name: string, patch: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 70, creditsRemaining: null, resetAt: RESET,
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage' as const, asOf: at(0.04) }, ...patch,
});
const ledger = (...lanes: ResourceLaneRow[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: at(0), sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
});
const rows = (pool: string, points: [number, number][]): PoolSample[] =>
  points.map(([hoursAgo, used]) => ({ pool, used_pct: used, observed_at: at(hoursAgo), reset_at: RESET }));

describe('pool verdicts', () => {
  it('says a fast pool runs empty before its reset: slow down', () => {
    const view = buildPoolsView(ledger(lane('claude')), NOW, rows('claude', [[3, 59], [2, 64], [1.4, 67], [0.04, 70]]));
    const claude = view.pools[0]!;
    expect(claude).toMatchObject({ verdict: 'slow down', wasteRisk: 'low', burnBasis: 'least-squares', burn: { samples: 4, method: 'least-squares-6h' } });
    expect(claude.burnPctPerHour).toBeGreaterThan(3);
    expect(claude.summary).toMatch(/^Claude: empty about \d{1,2} (AM|PM) \w{3}, \d+ h before reset: slow down$/);
    // Empty well before the reset: 30 points left at 3.x per hour is under 10 hours.
    const emptyHours = (Date.parse(claude.projectedEmptyAt!) - NOW) / 3_600_000;
    expect(emptyHours).toBeGreaterThan(7);
    expect(emptyHours).toBeLessThan(10);
    expect(claude.projectedUnusedPct).toBe(0);
  });

  it('says a slow pool will leave usage unused: add work', () => {
    const view = buildPoolsView(ledger(lane('zai', { usedPct: 30 })), NOW, rows('zai', [[3, 29], [2, 29.4], [0.04, 30]]));
    const zai = view.pools[0]!;
    expect(zai).toMatchObject({ verdict: 'add work', projectedEmptyAt: null });
    expect(zai.summary).toMatch(/^Zai: \d+% will go unused: add work$/);
  });

  it('says on pace when the burn lands near the reset', () => {
    const view = buildPoolsView(ledger(lane('codex-cmp', { usedPct: 60 })), NOW, rows('codex-cmp', [[3, 56.7], [2, 57.8], [0.04, 60]]));
    expect(view.pools[0]).toMatchObject({ verdict: 'on pace', summary: 'Codex cmp: on pace' });
  });

  it('says not enough readings with fewer than three, and does not guess from the window average', () => {
    const view = buildPoolsView(ledger(lane('claude')), NOW, rows('claude', [[1, 66]]));
    expect(view.pools[0]).toMatchObject({ verdict: 'not enough readings', burnPctPerHour: null, projectedUnusedPct: null, projectedEmptyAt: null,
      burn: { samples: 2, method: 'least-squares-6h' } });
    expect(view.pools[0]!.summary).toBe('Claude: not enough readings (2 of 3 in the last 6 h)');
  });

  it('ignores the pool readings from before its reset', () => {
    const before = rows('claude', [[5, 99], [4, 99.5]]).map(r => ({ ...r, reset_at: '2026-11-13T23:00:00.000Z' }));
    const after = rows('claude', [[3, 2], [2, 4], [1, 6], [0.04, 8]]);
    const view = buildPoolsView(ledger(lane('claude', { usedPct: 8 })), NOW, [...before, ...after]);
    expect(view.pools[0]!.burn.samples).toBe(4);
    expect(view.pools[0]!.burnPctPerHour).toBeCloseTo(2, 0);
  });

  it('lists a pool that runs empty early before one that only wastes', () => {
    const view = buildPoolsView(ledger(lane('zai', { usedPct: 10, burnPctPerHour: 0.1 }), lane('claude')), NOW, rows('claude', [[3, 59], [2, 64], [0.04, 70]]));
    expect(view.pools.map(p => p.id)).toEqual(['claude', 'zai']);
  });
});
