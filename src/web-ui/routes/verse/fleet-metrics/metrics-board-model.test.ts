import { describe, expect, it } from 'vitest';
import type { FleetMetricsSeries } from '../../../../core/fleet/metrics-series.js';
import { busiestHour, laneOutcome, mergedTrend, repoShares } from './metrics-board-model.js';

const series = (known: boolean, perHour: Array<Record<string, number>> = []): FleetMetricsSeries => ({
  schema: 'fleet.metrics-series.v1', known, observedAt: '2026-11-17T12:00:00Z', since: '2026-11-16T12:00:00Z', mergesLastHour: null, mergesLast24h: null, malformedLines: 0,
  hours: Array.from({ length: 24 }, (_, i) => {
    const byRepo = perHour[i] ?? {};
    return { start: new Date(Date.UTC(2026, 10, 16, 12 + i)).toISOString(), end: new Date(Date.UTC(2026, 10, 16, 13 + i)).toISOString(),
      merged: known ? Object.values(byRepo).reduce((sum, n) => sum + n, 0) : null, byRepo, launches: known ? 0 : null, mergesPerLaunch: null };
  }),
});

describe('Metrics board readings', () => {
  it('totals merges per repo, most first, with the share of all merges and a bar against the top repo', () => {
    expect(repoShares(series(true, [{ phantom: 2, locus: 1 }, { phantom: 4 }, { stack: 1 }]))).toEqual([
      { repo: 'phantom', merged: 6, sharePct: 75, barPct: 100 },
      { repo: 'locus', merged: 1, sharePct: 13, barPct: 17 },
      { repo: 'stack', merged: 1, sharePct: 13, barPct: 17 },
    ]);
  });

  it('lists no repo when nothing merged or history is unknown', () => {
    expect(repoShares(series(true))).toEqual([]);
    expect(repoShares(series(false))).toEqual([]);
    expect(repoShares(undefined)).toEqual([]);
  });

  it('gives the sparkline the measured hours only when history is known', () => {
    expect(mergedTrend(series(true, [{ phantom: 2 }]))!.slice(0, 3)).toEqual([2, 0, 0]);
    expect(mergedTrend(series(false))).toBeUndefined();
    expect(mergedTrend(undefined)).toBeUndefined();
  });

  it('names the busiest hour, the later one on a tie, and none for a quiet or unknown window', () => {
    const busy = series(true, [{ phantom: 3 }, {}, { locus: 3 }, { phantom: 1 }]);
    expect(busiestHour(busy)).toMatchObject({ start: busy.hours[2]!.start, merged: 3 });
    expect(busiestHour(series(true))).toBeNull();
    expect(busiestHour(series(false))).toBeNull();
  });

  it('draws a lane outcome only when both shares are measured, and never past the whole bar', () => {
    expect(laneOutcome({ merge_rate: 0.75, empty_rate: 0.2 })).toEqual({ mergedPct: 75, emptyPct: 20 });
    expect(laneOutcome({ merge_rate: 0.7, empty_rate: 0.5 })).toEqual({ mergedPct: 70, emptyPct: 30 });
    expect(laneOutcome({ merge_rate: 0, empty_rate: 0 })).toEqual({ mergedPct: 0, emptyPct: 0 });
    expect(laneOutcome({ merge_rate: null, empty_rate: 0.2 })).toBeNull();
    expect(laneOutcome({ merge_rate: 0.5, empty_rate: null })).toBeNull();
  });
});
