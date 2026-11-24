/**
 * Where a pool's stored readings sit in its current window, as plot coordinates. Pure. The readings and the even line
 * come from fleet.usage-history.v1 (`phm fleet usage-history`); the line ahead of the newest reading ends where
 * pools.v1 (`phm pools`) says this burn ends, so the chart and the card's readings cannot disagree. Nothing is drawn
 * that neither read holds: one reading is one point, and a pool without a reset time has no window to draw.
 */
import type { PoolRow } from '../../../../core/fleet/pools-view.js';
import type { PoolUsageSeries } from '../../../../core/fleet/usage-history.js';

const DAY_MS = 86_400_000;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const ms = (iso: string | null): number => iso === null ? NaN : Date.parse(iso);

/** A point on the plot: `x` is the share of the window elapsed, `y` the share used, both 0 to 100. */
export interface WindowPoint { x: number; y: number }
export interface WindowChart {
  startMs: number;
  endMs: number;
  /** Every stored reading of this window, oldest first. */
  points: WindowPoint[];
  /** The same readings as stored, one per point and in the same order: when each was taken and the share it measured. */
  stored: { atMs: number; usedPct: number }[];
  /** Where the view's clock sits in the window; null before its start or after its reset. */
  nowX: number | null;
  /** The end of each whole day counted from the window's start. */
  days: number[];
  /** From the newest reading to where pools.v1 says this burn ends; null when it gives no burn. */
  ahead: { from: WindowPoint; to: WindowPoint } | null;
  latest: { usedPct: number; atMs: number };
  /** The share the even line expects at the newest reading. */
  evenPct: number | null;
  /** Used minus even, in points: negative is under the line. */
  gap: number | null;
}
export type PoolWindow = { kind: 'chart'; chart: WindowChart } | { kind: 'none'; why: string };

const readings = (count: number): string => `${count} ${count === 1 ? 'reading' : 'readings'}`;

export function poolWindow(series: PoolUsageSeries | undefined, row: Pick<PoolRow, 'usedPct' | 'projectedEmptyAt' | 'projectedUnusedPct'>, nowMs: number): PoolWindow {
  if (!series || series.points.length === 0) return { kind: 'none', why: 'No stored readings for this window yet.' };
  const startMs = ms(series.ideal?.from.at ?? null), endMs = ms(series.ideal?.to.at ?? null);
  if (!(endMs > startMs)) return { kind: 'none', why: `Reset time unknown, so the window cannot be drawn (${readings(series.points.length)} stored).` };
  const x = (time: number): number => round2(Math.min(100, Math.max(0, (time - startMs) / (endMs - startMs) * 100)));
  const y = (pct: number): number => round2(Math.min(100, Math.max(0, pct)));
  const stored = series.points.filter(point => Number.isFinite(ms(point.at))).sort((a, b) => ms(a.at) - ms(b.at));
  const last = stored.at(-1);
  if (!last) return { kind: 'none', why: 'No stored readings for this window yet.' };
  const from = { x: x(ms(last.at)), y: y(last.used_pct) };
  const days: number[] = [];
  for (let time = startMs + DAY_MS; time < endMs; time += DAY_MS) days.push(x(time));
  // The line ahead needs a current reading on the card; a stale pool keeps its history and projects nothing.
  let to: WindowPoint | null = null;
  if (row.usedPct !== null && nowMs < endMs) {
    const emptyMs = ms(row.projectedEmptyAt);
    if (Number.isFinite(emptyMs)) to = { x: x(emptyMs), y: 100 };
    else if (row.projectedUnusedPct !== null) to = { x: 100, y: Math.max(from.y, y(100 - row.projectedUnusedPct)) };
  }
  const even = series.ideal_pct;
  return { kind: 'chart', chart: {
    startMs, endMs, points: stored.map(point => ({ x: x(ms(point.at)), y: y(point.used_pct) })),
    stored: stored.map(point => ({ atMs: ms(point.at), usedPct: point.used_pct })),
    nowX: nowMs > startMs && nowMs < endMs ? x(nowMs) : null, days,
    ahead: to !== null && to.x > from.x ? { from, to } : null,
    latest: { usedPct: last.used_pct, atMs: ms(last.at) },
    evenPct: even, gap: even === null ? null : round1(last.used_pct - even),
  } };
}

/** The newest reading against the even line, in words: "60% used against 64.3% on the even line: 4.3 points under." */
export function gapWords(chart: { latest: { usedPct: number }; evenPct: number | null; gap: number | null }): string {
  if (chart.evenPct === null || chart.gap === null) return `${chart.latest.usedPct}% used.`;
  const side = chart.gap === 0 ? 'on it' : `${Math.abs(chart.gap)} ${Math.abs(chart.gap) === 1 ? 'point' : 'points'} ${chart.gap < 0 ? 'under' : 'over'}`;
  return `${chart.latest.usedPct}% used against ${chart.evenPct}% on the even line: ${side}.`;
}

/** How many readings the chart draws: "41 readings". */
export const readingCount = (chart: Pick<WindowChart, 'points'>): string => readings(chart.points.length);

/** One stored reading, read off the chart: when it was taken, what it measured and where the even line stood then. */
export interface WindowReading { index: number; of: number; atMs: number; usedPct: number; evenPct: number; gap: number }

/**
 * The reading at `index`, or null when the chart holds none there. The even line at a reading is the share of the
 * window that had run when it was taken; the newest reading takes the route's own figure, so the caption and a
 * reading stepped to cannot disagree.
 */
export function readingAt(chart: Pick<WindowChart, 'startMs' | 'endMs' | 'stored' | 'evenPct'>, index: number): WindowReading | null {
  const stored = chart.stored[index];
  if (!stored) return null;
  const share = round1(Math.min(100, Math.max(0, (stored.atMs - chart.startMs) / (chart.endMs - chart.startMs) * 100)));
  const evenPct = index === chart.stored.length - 1 && chart.evenPct !== null ? chart.evenPct : share;
  return { index, of: chart.stored.length, atMs: stored.atMs, usedPct: stored.usedPct, evenPct, gap: round1(stored.usedPct - evenPct) };
}

/** The reading drawn nearest to `x` (a share of the window, 0 to 100); the later one on a tie. -1 when there is none. */
export function nearestReading(chart: Pick<WindowChart, 'points'>, x: number): number {
  let best = -1, distance = Infinity;
  chart.points.forEach((point, index) => {
    const away = Math.abs(point.x - x);
    if (away <= distance) { best = index; distance = away; }
  });
  return best;
}

/** A reading in words: "Reading 2 of 3, Sun, Nov 15, 12:00 PM: 30% used against 35.7% on the even line: 5.7 points under." */
export function readingWords(reading: WindowReading, time: (ms: number) => string): string {
  return `Reading ${reading.index + 1} of ${reading.of}, ${time(reading.atMs)}: ${gapWords({ latest: reading, evenPct: reading.evenPct, gap: reading.gap })}`;
}

/** Where a key moves the reading being read; null for a key the chart does not take. The arrows stop at the ends. */
export function stepReading(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, index - 1);
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(count - 1, index + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
