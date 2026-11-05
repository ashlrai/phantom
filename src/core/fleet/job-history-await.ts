import { JOB_BATCH_MAX, jobHistoryBatch, type JobHistoryBatchResult } from './job-history-batch.js';
import { JOB_LIMIT_MAX, validJobId } from './job-path-history.js';

/** Longest wall-clock await the CLI accepts; keeps one invocation bounded. */
export const AWAIT_MS_MAX = 60_000;
export const INTERVAL_MS_MIN = 250;
export const INTERVAL_MS_MAX = 10_000;
export const INTERVAL_MS_DEFAULT = 1_000;

/**
 * Injectable clock/timer/reader so tests never sleep or touch git. `now` must
 * be monotonic milliseconds; `setTimeout`/`clearTimeout` mirror the globals.
 */
export interface AwaitEnv {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  read: (jobIds: string[], limit: number) => Promise<JobHistoryBatchResult>;
}

const defaultEnv: AwaitEnv = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
  read: (jobIds, limit) => jobHistoryBatch(jobIds, limit),
};

export interface JobHistoryAwaitResult {
  outcome: 'observed' | 'deadline';
  jobIds: string[];
  awaitMs: number;
  intervalMs: number;
  elapsedMs: number;
  observations: number;
  observedIds: string[];
  pendingIds: string[];
  /** Last completed bounded snapshot, or null when the reader outlived the deadline. */
  snapshot: JobHistoryBatchResult | null;
}

/**
 * Bounded repeated observation of recorded bridge commits for a batch of exact
 * job ids. Each observation calls the batch reader once for all ids; a new
 * observation is never scheduled while one is in flight or once the wall
 * deadline has passed. An in-flight reader that outlives the deadline is
 * abandoned safely — a late rejection is swallowed, a late value only fills the
 * final snapshot — and no timer is retained after return. Reader errors before
 * the deadline propagate (the caller sanitizes them); they are never treated as
 * success or as empty evidence. Awaiting never fetches, dispatches, merges or
 * writes fleet state, and pending ids are never declared unmerged.
 */
export async function awaitJobHistory(
  jobIds: string[], limit: number, awaitMs: number, intervalMs: number = INTERVAL_MS_DEFAULT,
  env: Partial<AwaitEnv> = {},
): Promise<JobHistoryAwaitResult> {
  if (!Array.isArray(jobIds) || jobIds.length < 1 || jobIds.length > JOB_BATCH_MAX
    || new Set(jobIds).size !== jobIds.length
    || jobIds.some(id => typeof id !== 'string' || !validJobId(id))
    || !Number.isInteger(limit) || limit < 1 || limit > JOB_LIMIT_MAX
    || !Number.isInteger(awaitMs) || awaitMs < 0 || awaitMs > AWAIT_MS_MAX
    || !Number.isInteger(intervalMs) || intervalMs < INTERVAL_MS_MIN || intervalMs > INTERVAL_MS_MAX) {
    throw new Error('invalid job history await arguments');
  }
  const e: AwaitEnv = { ...defaultEnv, ...env };
  const started = e.now();
  const deadline = started + awaitMs;
  let observations = 0;
  let snapshot: JobHistoryBatchResult | null = null;
  for (;;) {
    const remaining = deadline - e.now();
    if (observations > 0 && remaining <= 0) break;
    observations += 1;
    const reading = e.read(jobIds, limit);
    if (remaining > 0) {
      let timer: unknown;
      try {
        const expired = new Promise<null>(resolve => { timer = e.setTimeout(() => resolve(null), remaining); });
        const raced = await Promise.race([reading.then(value => ({ value })), expired]);
        if (raced === null) {
          // Reader outlived the wall deadline: keep its late settle harmless.
          reading.then(value => { snapshot = value; }, () => {});
          break;
        }
        snapshot = raced.value;
      } finally { e.clearTimeout(timer); }
    } else {
      // No wall budget remains (e.g. --await-ms 0): still complete this one observation.
      snapshot = await reading;
    }
    if (snapshot.jobs.every(job => job.commits.length > 0)) break;
    const left = deadline - e.now();
    if (left <= 0) break;
    await new Promise<void>(resolve => { e.setTimeout(resolve, Math.min(intervalMs, left)); });
  }
  const observedIds = snapshot ? snapshot.jobs.filter(job => job.commits.length > 0).map(job => job.jobId) : [];
  const outcome = observedIds.length === jobIds.length ? 'observed' : 'deadline';
  return {
    outcome, jobIds: [...jobIds], awaitMs, intervalMs,
    elapsedMs: Math.max(0, Math.round(e.now() - started)),
    observations, observedIds,
    pendingIds: jobIds.filter(id => !observedIds.includes(id)),
    snapshot,
  };
}
