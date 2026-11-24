/** The Throughput board's reading cursor: the report's hours as one row of bars, and what one held bar says.
 * A 6 or 24 hour window is a bar an hour; 7 days folds to a bar per 7 hours, the same fold the Models board draws.
 * Pure. A bar's counts are the report's own hours added up; a count any of its hours does not hold stays null, so
 * the board writes "unknown" for it. A median is kept per hour only, so a folded bar has none of its own. */
import type { ThroughputHour } from '../../../../core/fleet/throughput.js';
import { WORK_COLUMNS, columnWhen, type WorkColumn } from '../models/model-work-model.js';
import { span, type Figure } from './throughput-board-model.js';

type CountKey = 'launched' | 'published' | 'merged' | 'finished' | 'empty';
const KEYS: readonly CountKey[] = ['launched', 'published', 'merged', 'finished', 'empty'];

/** One bar. `launched` and `merged` are what is drawn (0 where unread, and then `read` is false); `counts` is what is said. */
export interface HourBar extends WorkColumn {
  /** False when the report holds no launch count for one of the bar's hours: hatched, never an empty bar. */
  read: boolean;
  counts: Readonly<Record<CountKey, number | null>>;
  /** Share of finished jobs that changed nothing; null when none finished or a count is missing. */
  emptyRate: number | null;
  /** Median seconds from publish to merge, for a bar of one hour; null for a folded bar or an hour with no timed merge. */
  median: number | null;
}

const total = (hours: readonly ThroughputHour[], key: CountKey): number | null =>
  hours.some(hour => hour[key] === null) ? null : hours.reduce((sum, hour) => sum + (hour[key] ?? 0), 0);

/** The hours folded into at most `max` equal bars, oldest first. Lanes and the fleet fold alike, so one start names one bar on all of them. */
export function cursorBars(buckets: readonly ThroughputHour[], max = WORK_COLUMNS): HourBar[] {
  const size = Math.max(1, Math.ceil(buckets.length / max));
  const bars: HourBar[] = [];
  for (let i = 0; i < buckets.length; i += size) {
    const hours = buckets.slice(i, i + size), one = hours.length === 1 ? hours[0]! : null;
    const counts = Object.fromEntries(KEYS.map(key => [key, total(hours, key)])) as Record<CountKey, number | null>;
    bars.push({
      start: hours[0]!.start, hours: hours.length, launched: counts.launched ?? 0, merged: counts.merged ?? 0, read: counts.launched !== null, counts,
      emptyRate: one ? one.empty_rate : counts.finished && counts.empty !== null ? counts.empty / counts.finished : null,
      median: one ? one.median_publish_to_merge_s : null,
    });
  }
  return bars;
}

/** The most jobs launched in any one bar of the rows given; 0 when nothing was. */
export const mostLaunched = (rows: readonly (readonly HourBar[])[]): number => Math.max(0, ...rows.flatMap(row => row.map(bar => bar.launched)));

const plural = (value: number | null, one: string, many: string): string => value === null ? `${many} unknown` : `${value} ${value === 1 ? one : many}`;
const shown = (value: number | null): string => value === null ? 'unknown' : String(value);
/** "hour", "7 hours": what one bar covers. */
export const barUnit = (bar: Pick<HourBar, 'hours'>): string => bar.hours === 1 ? 'hour' : `${bar.hours} hours`;
const stretch = (bar: Pick<HourBar, 'hours'>): string => bar.hours === 1 ? 'this hour' : `these ${bar.hours} hours`;

/** The fleet's sentence for one bar: when, then every count it holds. */
export function barWords(bar: HourBar, timeZone?: string): string {
  const { launched, published, merged, finished, empty } = bar.counts;
  const done = finished === null || empty === null ? '' : finished === 0 ? ', no job finished' : `, ${empty} of ${finished} finished jobs changed nothing`;
  return `${columnWhen(bar, timeZone)}: ${plural(launched, 'job launched', 'jobs launched')}, ${plural(published, 'PR published', 'PRs published')}, ${plural(merged, 'PR merged', 'PRs merged')}${done}.`;
}
/** The same bar on a lane card, where the card's own labels are in view: shorter. */
export const laneBarWords = (bar: HourBar, timeZone?: string): string =>
  `${columnWhen(bar, timeZone)}: launched ${shown(bar.counts.launched)}, published ${shown(bar.counts.published)}, merged ${shown(bar.counts.merged)}`;

/** What a row of bars says while none is held: its busiest bar (the latest on a tie), or that nothing was launched. */
export function busiestWords(bars: readonly HourBar[], timeZone?: string): string {
  if (bars.some(bar => !bar.read)) return 'Launches unknown for part of this window';
  let best: HourBar | null = null;
  for (const bar of bars) if (bar.launched > 0 && (!best || bar.launched >= best.launched)) best = bar;
  return best ? `Busiest: ${columnWhen(best, timeZone)}, ${best.launched} launched` : 'No job launched in this window';
}

/** The figure tiles while a bar is held: each count becomes that bar's own. The median stays the window's on a folded bar, and says so. */
export function heldFigures(base: readonly Figure[], bar: HourBar): Figure[] {
  const where = stretch(bar), counts = bar.counts;
  return base.map((figure): Figure => {
    if (figure.id === 'median') {
      if (bar.hours !== 1) return { ...figure, caption: `Whole window: no median is kept for a ${bar.hours} hour bar` };
      return {
        ...figure, held: true, value: span(bar.median), known: bar.median !== null,
        caption: bar.median !== null ? `From publish to merge, in ${where}` : counts.merged === 0 ? `No PR merged in ${where}.` : `No timed merge in ${where}.`,
      };
    }
    if (figure.id === 'empty') {
      const rate = counts.finished ? bar.emptyRate : null;
      return {
        ...figure, held: true, peak: null, known: rate !== null,
        value: rate !== null ? `${Math.round(rate * 100)}%` : counts.finished === 0 ? 'no rate' : 'unknown',
        caption: rate !== null ? `${shown(counts.empty)} of ${shown(counts.finished)} finished jobs, in ${where}` : counts.finished === 0 ? `No job finished in ${where}.` : `In ${where}`,
      };
    }
    const value = counts[figure.id];
    return { ...figure, held: true, peak: null, value: shown(value), known: value !== null, caption: `In ${where}` };
  });
}
