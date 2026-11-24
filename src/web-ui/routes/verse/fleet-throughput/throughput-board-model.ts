/** Pure shaping of the `phm throughput` report for the Throughput board: the figure tiles and the lane cards.
 * Every count is the report's own. The only arithmetic here is picking the largest hour and comparing lanes with the lane that merged most.
 * A value the report holds as null stays null, so the board writes "unknown" and draws no line for it. */
import type { ThroughputCounts, ThroughputGroup, ThroughputHour, ThroughputReport } from '../../../../core/fleet/throughput.js';

export type Series = (number | null)[];
export interface Peak { value: number; start: string }
export interface Figure {
  id: 'launched' | 'published' | 'merged' | 'empty' | 'median';
  label: string;
  /** The figure in words or digits; "unknown" when the report holds none. */
  value: string;
  known: boolean;
  /** One point per hour, oldest first; null when no hour holds a value, so nothing is drawn. */
  trend: Series | null;
  trendLabel: string;
  /** The hour with the most, for the three counts; null when every hour is zero or unknown. */
  peak: Peak | null;
  caption: string | null;
  /** True while the tile shows one held bar of the reading cursor instead of the window (throughput-cursor-model.ts). */
  held?: boolean;
}
export interface LaneRow {
  name: string;
  merged: number | null; launched: number | null; published: number | null;
  /** Merged against the lane that merged most, 0..1; null when this lane's count is unknown or no lane merged. */
  share: number | null;
  /** "1 of 40 (3%)", "none finished" or "unknown". */
  emptyText: string;
  emptyRate: number | null;
  median: string;
}

const UNKNOWN = 'unknown';
const count = (value: number | null): string => value === null ? UNKNOWN : String(value);
const drawn = (points: Series): Series | null => points.some(point => point !== null) ? points : null;

/** "50s", "2m 50s", "1h 4m": the same wording as the report's headline. */
export function span(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return UNKNOWN;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The hour with the largest count, the latest one on a tie. Null when no hour has more than zero. */
export function peakHour(hours: readonly ThroughputHour[], pick: (hour: ThroughputHour) => number | null): Peak | null {
  let best: Peak | null = null;
  for (const hour of hours) {
    const value = pick(hour);
    if (value !== null && value > 0 && (!best || value >= best.value)) best = { value, start: hour.start };
  }
  return best;
}

/** Empty jobs over finished jobs in words. No job finished is a fact, not a 0% rate. */
export function emptyText(counts: ThroughputCounts): string {
  if (counts.finished === null || counts.empty === null) return UNKNOWN;
  if (counts.finished === 0 || counts.empty_rate === null) return 'none finished';
  return `${counts.empty} of ${counts.finished} (${Math.round(counts.empty_rate * 100)}%)`;
}

export function figures(report: ThroughputReport): Figure[] {
  const { totals, buckets } = report;
  const tally = (id: 'launched' | 'published' | 'merged', label: string, what: string): Figure => ({
    id, label, value: count(totals[id]), known: totals[id] !== null,
    trend: drawn(buckets.map(hour => hour[id])), trendLabel: `${what} each hour`, peak: peakHour(buckets, hour => hour[id]), caption: null,
  });
  const rate = totals.empty_rate;
  const noneFinished = totals.finished === 0;
  return [
    tally('launched', 'Launched', 'Jobs launched'),
    tally('published', 'Published', 'PRs published'),
    tally('merged', 'Merged', 'PRs merged'),
    {
      id: 'empty', label: 'Changed nothing', value: rate !== null ? `${Math.round(rate * 100)}%` : noneFinished ? 'no rate' : UNKNOWN, known: rate !== null,
      trend: drawn(buckets.map(hour => hour.empty)), trendLabel: 'Jobs that changed nothing each hour', peak: null,
      caption: rate !== null ? `${count(totals.empty)} of ${count(totals.finished)} finished jobs` : noneFinished ? 'No job finished in this window.' : null,
    },
    {
      id: 'median', label: 'Median to merge', value: span(totals.median_publish_to_merge_s), known: totals.median_publish_to_merge_s !== null,
      trend: drawn(buckets.map(hour => hour.median_publish_to_merge_s === null ? null : Math.round(hour.median_publish_to_merge_s / 6) / 10)),
      trendLabel: 'Median minutes to merge each hour', peak: null,
      caption: totals.median_publish_to_merge_s !== null ? 'From publish to merge' : totals.merged === 0 ? 'No PR merged in this window.' : null,
    },
  ];
}

/** One row per lane, the lane that merged most first; a lane with no count goes last. Ties keep the busier lane, then the name. */
export function laneRows(groups: readonly ThroughputGroup[]): LaneRow[] {
  const top = Math.max(0, ...groups.map(group => group.totals.merged ?? 0));
  const rank = (value: number | null): number => value === null ? -1 : value;
  return groups.map(({ name, totals }): LaneRow => ({
    name, merged: totals.merged, launched: totals.launched, published: totals.published,
    share: totals.merged === null || top === 0 ? null : totals.merged / top,
    emptyText: emptyText(totals), emptyRate: totals.finished ? totals.empty_rate : null,
    median: span(totals.median_publish_to_merge_s),
  })).sort((a, b) => rank(b.merged) - rank(a.merged) || rank(b.launched) - rank(a.launched) || a.name.localeCompare(b.name));
}
