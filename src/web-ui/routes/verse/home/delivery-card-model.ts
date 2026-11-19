/** What Home's Merged PRs card draws from the `phm throughput` report (throughput.v1): one bar per hour and one row per lane that merged. Nothing is estimated; a count the report does not hold stays null. */
import type { ThroughputReport } from '../../../../core/fleet/throughput.js';

/** Home is a glance; the Throughput pane holds every lane. */
export const DELIVERY_LANE_LIMIT = 5;

/** Only a well-formed throughput.v1 payload is a report: an older server or an error body is not a measurement. */
export function throughputOf(data: unknown): ThroughputReport | null {
  if (data === null || typeof data !== 'object') return null;
  const report = data as Partial<ThroughputReport>;
  return report.schema === 'throughput.v1' && Array.isArray(report.buckets) && Array.isArray(report.groups) && !!report.totals ? report as ThroughputReport : null;
}

export interface HourBar { start: string; merged: number | null; /** 0..1 of the busiest hour; 0 for a quiet or unknown hour. */ share: number }
export interface HourBars { bars: HourBar[]; /** The busiest hour, the latest one on a tie. Null when nothing merged. */ peak: HourBar | null; /** Hours whose count is known. */ known: number }

/** Oldest hour first, as the report sends them. The scale is the busiest hour, so the tallest bar is always a real count. */
export function hourBars(report: ThroughputReport): HourBars {
  const counts = report.buckets.map(hour => typeof hour.merged === 'number' && Number.isFinite(hour.merged) ? Math.max(0, hour.merged) : null);
  const top = Math.max(0, ...counts.map(count => count ?? 0));
  const bars = report.buckets.map((hour, index) => ({ start: hour.start, merged: counts[index] ?? null, share: top > 0 ? (counts[index] ?? 0) / top : 0 }));
  const peak = top > 0 ? [...bars].reverse().find(bar => bar.merged === top) ?? null : null;
  return { bars, peak, known: counts.filter(count => count !== null).length };
}

export interface LaneRow { name: string; merged: number; /** 0..1 of the lane that merged most. */ share: number }

/** Lanes that merged at least one PR in the window, most first, then by name. `more` counts the lanes left for the Throughput pane. */
export function laneRows(report: ThroughputReport, limit = DELIVERY_LANE_LIMIT): { rows: LaneRow[]; more: number } {
  const merged = report.groups.flatMap(group => typeof group.totals.merged === 'number' && group.totals.merged > 0 ? [{ name: group.name, merged: group.totals.merged }] : [])
    .sort((a, b) => b.merged - a.merged || a.name.localeCompare(b.name));
  const top = merged[0]?.merged ?? 0;
  return { rows: merged.slice(0, limit).map(lane => ({ ...lane, share: lane.merged / top })), more: Math.max(0, merged.length - limit) };
}

/** The three window totals in order, or null when the report does not hold all of them. */
export function flowSteps(report: ThroughputReport): { id: 'launched' | 'published' | 'merged'; value: number }[] | null {
  const { launched, published, merged } = report.totals;
  if (typeof launched !== 'number' || typeof published !== 'number' || typeof merged !== 'number') return null;
  return [{ id: 'launched', value: launched }, { id: 'published', value: published }, { id: 'merged', value: merged }];
}
