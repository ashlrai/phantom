/**
 * core/fleet/job-overrun.ts — flag running jobs that have far outlived their
 * lane's normal finished duration ("Overrun 2.4x lane median").
 *
 * Pure projection over finished-job durations: the caller supplies finished
 * records newest-first (the ordering the metrics-ledger activity fold emits)
 * and the running job's measured elapsed time. No IO, no mutation, no clock
 * reads beyond the passed nowMs — the server read composes this with the live
 * process table and the bounded jobs.jsonl tail.
 *
 * Flagging only: nothing here stops, requeues or reprioritizes a job.
 */

/** One finished job's lane and run duration, as emitted by the ledger fold. */
export interface FinishedJobDuration {
  lane: string | null | undefined;
  /** Run duration in ms; non-finite or non-positive values never count. */
  durationMs: number | null | undefined;
}

export interface LaneMedianOptions {
  /** Newest finished durations kept per lane. Default 200. */
  window?: number;
  /** A lane needs at least this many valid durations to report a median. Default 5. */
  minSamples?: number;
}

export const OVERRUN_DEFAULT_WINDOW = 200;
export const OVERRUN_MIN_SAMPLES = 5;
export const OVERRUN_DEFAULT_RATIO = 2;
export const OVERRUN_DEFAULT_FLOOR_MS = 20 * 60_000;

/** Median of an ascending list; null when empty. */
const medianOf = (sorted: readonly number[]): number | null => {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * Median duration per lane over that lane's newest `window` finished records.
 * Records are consumed newest-first; each lane keeps at most `window` valid
 * durations, and lanes with fewer than `minSamples` of them are omitted.
 */
export function laneMedians(finished: Iterable<FinishedJobDuration>, options: LaneMedianOptions = {}): Map<string, number> {
  const window = Number.isSafeInteger(options.window) && options.window! > 0 ? options.window! : OVERRUN_DEFAULT_WINDOW;
  const minSamples = Number.isSafeInteger(options.minSamples) && options.minSamples! > 0 ? options.minSamples! : OVERRUN_MIN_SAMPLES;
  const samples = new Map<string, number[]>();
  for (const row of finished) {
    const lane = row?.lane;
    const durationMs = row?.durationMs;
    if (typeof lane !== 'string' || lane === ''
      || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    const list = samples.get(lane) ?? [];
    if (list.length >= window) continue;
    list.push(durationMs);
    samples.set(lane, list);
  }
  const medians = new Map<string, number>();
  for (const [lane, durations] of samples) {
    if (durations.length < minSamples) continue;
    durations.sort((a, b) => a - b);
    const median = medianOf(durations);
    if (median !== null) medians.set(lane, median);
  }
  return medians;
}

/** A running job as the fleet read reports it; every field is optional evidence. */
export interface OverrunJob {
  lane?: string | null;
  /** Already-measured elapsed ms; wins over ageSeconds and startedAt. */
  elapsedMs?: number | null;
  /** Process age in seconds (the live process table's etime). */
  ageSeconds?: number | null;
  /** Launch instant as ms epoch or a parseable timestamp; measured against nowMs. */
  startedAt?: string | number | null;
}

/** The measured overrun: elapsed ÷ lane median, and the median it ran against. */
export interface OverrunFlag {
  ratio: number;
  medianMs: number;
}

export interface OverrunOptions {
  /** Flag threshold: elapsed must exceed ratio × lane median. Default 2. */
  ratio?: number;
  /** Flag threshold: elapsed must also exceed this floor. Default 20 minutes. */
  floorMs?: number;
}

const elapsedOf = (job: OverrunJob, nowMs: number): number | null => {
  if (typeof job.elapsedMs === 'number' && Number.isFinite(job.elapsedMs)) return job.elapsedMs;
  if (typeof job.ageSeconds === 'number' && Number.isFinite(job.ageSeconds)) return job.ageSeconds * 1000;
  const start = typeof job.startedAt === 'number' ? job.startedAt
    : typeof job.startedAt === 'string' ? Date.parse(job.startedAt) : NaN;
  return Number.isFinite(start) ? nowMs - start : null;
};

/**
 * The overrun flag for one running job, or null when there is no flag: the
 * job must carry a lane with a known median and an elapsed time that is both
 * over `floorMs` and over `ratio` × the median.
 */
export function overrunOf(job: OverrunJob, medians: ReadonlyMap<string, number>, nowMs: number, options: OverrunOptions = {}): OverrunFlag | null {
  const ratio = typeof options.ratio === 'number' && Number.isFinite(options.ratio) && options.ratio > 0
    ? options.ratio : OVERRUN_DEFAULT_RATIO;
  const floorMs = typeof options.floorMs === 'number' && Number.isFinite(options.floorMs)
    ? options.floorMs : OVERRUN_DEFAULT_FLOOR_MS;
  const lane = job?.lane;
  if (typeof lane !== 'string' || lane === '') return null;
  const medianMs = medians.get(lane);
  if (medianMs === undefined || !Number.isFinite(medianMs) || medianMs <= 0) return null;
  const elapsed = elapsedOf(job, nowMs);
  if (elapsed === null || !(elapsed > floorMs && elapsed > medianMs * ratio)) return null;
  return { ratio: Math.round((elapsed / medianMs) * 1000) / 1000, medianMs };
}
