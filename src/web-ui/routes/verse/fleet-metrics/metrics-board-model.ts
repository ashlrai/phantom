/** Pure readings for the Metrics board. Every figure comes from the `fleet.metrics-panel.v1` payload; nothing is estimated here. */
import type { MetricsLane } from '../../../../core/fleet/metrics-glance.js';
import type { FleetMetricsSeries, MetricsHour } from '../../../../core/fleet/metrics-series.js';

export interface RepoShare {
  repo: string;
  /** PRs merged in the 24 hourly buckets. */
  merged: number;
  /** Share of all merges in the window, 0..100. */
  sharePct: number;
  /** Bar length against the repo with the most merges, 0..100. */
  barPct: number;
}

/** Merges per repo over the window, most first, then by name. Empty when history is unknown or nothing merged. */
export function repoShares(series: FleetMetricsSeries | undefined): RepoShare[] {
  if (!series?.known) return [];
  const totals = new Map<string, number>();
  for (const hour of series.hours) for (const [repo, n] of Object.entries(hour.byRepo)) totals.set(repo, (totals.get(repo) ?? 0) + n);
  const all = [...totals.values()].reduce((sum, n) => sum + n, 0);
  const top = Math.max(0, ...totals.values());
  if (!all) return [];
  return [...totals].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([repo, merged]) => ({ repo, merged, sharePct: Math.round(merged / all * 100), barPct: Math.round(merged / top * 100) }));
}

/** Hourly merged counts for the tile's sparkline; undefined when history is unknown, so no line is drawn for it. */
export function mergedTrend(series: FleetMetricsSeries | undefined): (number | null)[] | undefined {
  return series?.known && series.hours.length > 1 ? series.hours.map(hour => hour.merged) : undefined;
}

/** The hour with the most merges; the latest one wins a tie. Null when history is unknown or nothing merged. */
export function busiestHour(series: FleetMetricsSeries | undefined): MetricsHour | null {
  if (!series?.known) return null;
  let best: MetricsHour | null = null;
  for (const hour of series.hours) if ((hour.merged ?? 0) > 0 && (hour.merged ?? 0) >= (best?.merged ?? 0)) best = hour;
  return best;
}

export interface LaneOutcome { mergedPct: number; emptyPct: number }

/** How a lane's finished jobs ended, as bar widths. Null when either share is unknown: a partial bar would read as a measurement. */
export function laneOutcome(lane: Pick<MetricsLane, 'merge_rate' | 'empty_rate'>): LaneOutcome | null {
  if (lane.merge_rate === null || lane.empty_rate === null) return null;
  const mergedPct = Math.round(Math.min(1, lane.merge_rate) * 100);
  return { mergedPct, emptyPct: Math.min(100 - mergedPct, Math.round(lane.empty_rate * 100)) };
}
