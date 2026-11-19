/**
 * Per-lane "held" summary for `fleet lanes`: a lane can look healthy while every
 * launch on it is written as `HELD: ...` to its `<job>.launch` file. Pure: the
 * caller reads the launch files and says which lane each job belongs to.
 */
import { unblockFor } from './fleet-held.js';

export interface LaneHeld {
  /** Plain words, e.g. "usage reading is 3 days old". */
  reason: string;
  /** ISO time of the first launch in the current unbroken run of held launches. */
  since: string;
  /** Held launches recorded in the last hour. */
  launches_held_1h: number;
  /** Age of the lane's newest usage reading in hours (one decimal); null when it has none. */
  meter_age_h: number | null;
  /** The one step that clears the hold. */
  next_step: string;
}

/** One `<job>.launch` file: first line and modified time (ms). */
export interface LaunchFile { job: string; firstLine: string; atMs: number }

export interface LaneHeldInput {
  launches: readonly LaunchFile[];
  laneOf(job: string): string | null;
  /** When the lane's usage reading was taken (ms), or null. */
  meterObservedAt(lane: string): number | null;
  now: number;
}

/** A lane that holds this many launches inside an hour gets one Leader notice a day. */
export const HELD_NOTICE_THRESHOLD = 3;
const HOUR_MS = 3_600_000;
export const HELD_LOOKBACK_MS = 24 * HOUR_MS;
const STALE_READING = /reading older than|stale (?:usage|reading)|usage (?:reading )?(?:is )?(?:stale|unknown)/i;

const isHeld = (line: string): boolean => line.trim() !== '' && !/^launched\b/i.test(line.trim());

function ageWords(hours: number): string {
  if (hours < 1) return 'under an hour old';
  if (hours < 48) { const h = Math.round(hours); return `${h} ${h === 1 ? 'hour' : 'hours'} old`; }
  return `${Math.round(hours / 24)} days old`;
}

/** "grok-ultra" reads as "Grok". */
const laneName = (lane: string): string => { const w = lane.split(/[-_.]/)[0] || lane; return w[0]!.toUpperCase() + w.slice(1); };

export function summarizeLaneHeld(input: LaneHeldInput): Map<string, LaneHeld> {
  const byLane = new Map<string, LaunchFile[]>();
  for (const launch of input.launches) {
    if (!launch.firstLine.trim() || launch.atMs > input.now || input.now - launch.atMs > HELD_LOOKBACK_MS) continue;
    const lane = input.laneOf(launch.job);
    if (lane) byLane.set(lane, [...(byLane.get(lane) ?? []), launch]);
  }
  const out = new Map<string, LaneHeld>();
  for (const [lane, files] of byLane) {
    files.sort((a, b) => b.atMs - a.atMs || a.job.localeCompare(b.job)); // newest first
    const held1h = files.filter(f => isHeld(f.firstLine) && input.now - f.atMs <= HOUR_MS).length;
    if (held1h === 0 || !isHeld(files[0]!.firstLine)) continue; // The newest launch went through: not held now.
    let since = files[0]!.atMs;
    for (const f of files) { if (!isHeld(f.firstLine)) break; since = f.atMs; }
    const line = files[0]!.firstLine.trim();
    const observed = input.meterObservedAt(lane);
    const meterAgeH = observed === null || observed > input.now ? null : Math.round((input.now - observed) / HOUR_MS * 10) / 10;
    const stale = STALE_READING.test(line);
    const unblock = unblockFor(line, lane);
    out.set(lane, {
      reason: stale
        ? `usage reading is ${meterAgeH === null ? 'out of date' : ageWords(meterAgeH)}`
        : line.replace(/^(?:HELD|PAUSED):\s*/i, ''),
      since: new Date(since).toISOString(),
      launches_held_1h: held1h,
      meter_age_h: meterAgeH,
      next_step: stale ? `Refresh the ${laneName(lane)} usage reading`
        : unblock === 'unknown' ? 'Run `phm fleet held` to see why' : unblock,
    });
  }
  return out;
}
