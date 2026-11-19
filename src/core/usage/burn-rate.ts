/**
 * Burn rate of a usage pool from its real readings: a least-squares slope over
 * the readings of the last 6 hours, with the evidence (`samples`, `window_h`,
 * `method`) beside the number so nobody has to trust it blind.
 *
 * Pure, no imports: browser-safe, shared by `phm pools` and the panes.
 *
 * Why not a window average: used% divided by hours since the window opened says
 * how fast the pool was spent on average, not how fast it is being spent now.
 * A pool that sat idle for four days and then climbed 3 points an hour read as
 * "0.5 points an hour" and the planner steered on that.
 *
 * Rules:
 *  - only readings from the last BURN_WINDOW_HOURS, never from the future;
 *  - a reading across a reset is dropped: a used share that goes down, or a
 *    changed reset time, starts a new window and the older readings are ignored;
 *  - fewer than BURN_MIN_SAMPLES readings (or no time spread) is "not enough
 *    readings", never a guess.
 */
export const BURN_WINDOW_HOURS = 6;
export const BURN_MIN_SAMPLES = 3;
export const BURN_METHOD = 'least-squares-6h' as const;
/** Reset times from one source can wobble by seconds; a bigger move is a new window. */
const RESET_JITTER_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

export interface BurnSample {
  /** When the reading was taken (ISO). */
  at: string;
  used_pct: number;
  reset_at?: string | null;
}
export interface BurnRead {
  /** Points of the pool used per hour; null when there are not enough readings. */
  points_per_hour: number | null;
  /** Readings the slope was fitted to (after the window and reset rules). */
  samples: number;
  /** Hours between the oldest and newest reading used. */
  window_h: number;
  method: typeof BURN_METHOD;
  /** Why points_per_hour is null; null otherwise. */
  reason: string | null;
}

const time = (iso: string | null | undefined): number => iso == null ? NaN : Date.parse(iso);
const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

/** The newest unbroken run of readings: oldest first, inside the window, none across a reset. */
export function burnSeries(samples: readonly BurnSample[], nowMs: number): BurnSample[] {
  const inWindow = samples
    .filter(s => Number.isFinite(time(s.at)) && time(s.at) <= nowMs && time(s.at) >= nowMs - BURN_WINDOW_HOURS * HOUR_MS
      && Number.isFinite(s.used_pct))
    .sort((a, b) => time(a.at) - time(b.at));
  let start = 0;
  for (let i = inWindow.length - 1; i > 0; i--) {
    const older = inWindow[i - 1]!;
    const newer = inWindow[i]!;
    const moved = Math.abs(time(newer.reset_at) - time(older.reset_at)) > RESET_JITTER_MS;
    if (newer.used_pct < older.used_pct || moved) { start = i; break; }
  }
  return inWindow.slice(start);
}

/** Pure. Least-squares slope (points per hour) of used share against time. */
export function burnRate(samples: readonly BurnSample[], nowMs: number): BurnRead {
  const series = burnSeries(samples, nowMs);
  const first = series[0];
  const last = series.at(-1);
  const spanH = first && last ? (time(last.at) - time(first.at)) / HOUR_MS : 0;
  const none = (reason: string): BurnRead => ({ points_per_hour: null, samples: series.length, window_h: round(spanH, 2), method: BURN_METHOD, reason });
  if (series.length < BURN_MIN_SAMPLES) return none(`${series.length} reading${series.length === 1 ? '' : 's'} in the last ${BURN_WINDOW_HOURS} h, need ${BURN_MIN_SAMPLES}`);
  if (spanH <= 0) return none('readings share one time');
  // Hours since the first reading keep the arithmetic small and exact.
  const xs = series.map(s => (time(s.at) - time(first!.at)) / HOUR_MS);
  const ys = series.map(s => s.used_pct);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i]! - meanX) * (ys[i]! - meanY); den += (xs[i]! - meanX) ** 2; }
  return { points_per_hour: round(Math.max(0, num / den), 2), samples: series.length, window_h: round(spanH, 2), method: BURN_METHOD, reason: null };
}
