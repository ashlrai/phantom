/**
 * Pure parse of dispatchd.log tick lines into the latest launch stall: the
 * newest consecutive run of ticks with work queued (q > 0) and nothing
 * launched. Shared by `phm fleet launch-stall` and the Lanes pane route.
 */
import { localTimestamp } from './runs-parked-queue.js';

export interface LaunchStallReport {
  startTime: string | null;
  minutes: number | null;
  lastQ: number | null;
  lastReap: number | null;
  min: number;
  stalled: boolean;
}

const TICK_RE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) tick run=\{.*\} q=(\d+) launched=(\d+) reap=(\d+)(?:\s|$)/;

/**
 * Any malformed tick line, empty queue or launch resets the run. A clock that
 * goes backwards restarts the run at that tick. Duration is first to last tick.
 */
export function parseLaunchStall(logText: string, minMinutes: number): LaunchStallReport {
  let start: { at: string; ms: number } | null = null;
  let last: { ms: number; q: number; reap: number } | null = null;
  for (const line of logText.split('\n')) {
    if (!/\btick run=/.test(line)) continue;
    const match = TICK_RE.exec(line);
    const stamp = match ? localTimestamp(match[1]!) : null;
    const q = match ? Number(match[2]) : NaN, launched = match ? Number(match[3]) : NaN, reap = match ? Number(match[4]) : NaN;
    if (!stamp || !Number.isFinite(stamp.ms) || ![q, launched, reap].every(Number.isSafeInteger) || q === 0 || launched !== 0) {
      start = null; last = null; continue;
    }
    if (last && stamp.ms < last.ms) start = null;
    start ??= stamp;
    last = { ms: stamp.ms, q, reap };
  }
  const minutes = start && last ? (last.ms - start.ms) / 60_000 : null;
  return { startTime: start?.at ?? null, minutes, lastQ: last?.q ?? null, lastReap: last?.reap ?? null, min: minMinutes, stalled: minutes !== null && minutes > minMinutes };
}
