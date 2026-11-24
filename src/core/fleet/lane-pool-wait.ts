/**
 * Is a lane's queue waiting on a used-up pool? One helper behind `phm lanes` (text and JSON)
 * and the gaps hook, so every surface counts the same rows as "cannot launch now".
 *
 * waiting   rows are queued, nothing runs, and the pool is at 98% used or more until it resets.
 * normal    a pool reading exists and the lane is not stuck behind it.
 * no-meter  no pool reading, so the answer is unknown (never read as normal).
 * Pure: the caller supplies the readings and the clock.
 */

/** A pool this used cannot start another job. */
export const POOL_USED_UP_PCT = 98;

export type PoolWaitState = 'waiting' | 'normal' | 'no-meter';

export interface PoolWaitInput {
  queued: number | null;
  running: number | null;
  /** Share of the pool used, 0 to 100; null when there is no reading. */
  usedPct: number | null;
  /** When the pool refills (ISO); null when unknown. */
  resetAt: string | null;
}

export interface PoolWait {
  state: PoolWaitState;
  queued: number | null;
  running: number | null;
  usedPct: number | null;
  resetAt: string | null;
  /** Queued rows that cannot launch now; 0 unless waiting. */
  waitingRows: number;
  /** One plain sentence. */
  words: string;
}

/** True when the pool is used up and has not yet reset. A reset already past means the reading is stale. */
export function poolUsedUp(usedPct: number | null, resetAt: string | null | undefined, nowMs: number): boolean {
  if (usedPct === null || usedPct < POOL_USED_UP_PCT) return false;
  const back = resetAt ? Date.parse(resetAt) : NaN;
  return !(Number.isFinite(back) && back <= nowMs);
}

/** "Sat 3:30 PM" in the reader's zone. */
const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function lanePoolWait(input: PoolWaitInput, nowMs: number): PoolWait {
  const { queued, running, usedPct, resetAt } = input;
  const base = { queued, running, usedPct, resetAt };
  if (usedPct === null) return { ...base, state: 'no-meter', waitingRows: 0, words: 'no meter: pool use is unknown' };
  if ((queued ?? 0) > 0 && running === 0 && poolUsedUp(usedPct, resetAt, nowMs)) {
    const rows = queued!;
    const until = resetAt && Number.isFinite(Date.parse(resetAt)) ? ` until ${when(resetAt)}` : '';
    return { ...base, state: 'waiting', waitingRows: rows, words: `waiting on a used-up pool${until} (${rows} ${rows === 1 ? 'row' : 'rows'})` };
  }
  return { ...base, state: 'normal', waitingRows: 0, words: `normal, pool ${Math.round(usedPct)}% used` };
}
