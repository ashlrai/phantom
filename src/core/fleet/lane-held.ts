import { unblockFor } from './fleet-held.js';

/**
 * lane-held.ts: which lanes' own wrapper holds every launch they are handed.
 * Pure over dispatch-events.log text; no IO, no authority. Backs
 * `phm lanes held`, the self-held block of `phm doctor supply`, and the
 * router's lane skip (lane-rank.ts).
 *
 * Event lines (written by the dispatcher, local time, no zone):
 *   LAUNCH <id> <repo> <lane> <tier>
 *   LAUNCH_DEFERRED <id> HELD (requeued, backoff 1800s)   (carries no lane; the
 *                                                          job's latest LAUNCH names it)
 *   PUBLISHED <id> ... | EMPTY_DONE <id> | EMPTY | SKIPPED-EMPTY | DONE-NOOP   (a finish)
 *
 * Per lane, over the last 60 minutes: `held` = HELD deferrals, `finishes` =
 * finished jobs launched there. Self-held = 3+ held and 0 finishes. A finish
 * clears it at once; otherwise it clears when the held events age out.
 * Malformed lines are counted and skipped; unrelated text is ignored.
 */
export const LANES_HELD_SCHEMA = 'lanes.held.v1';
export const LANE_HELD_WINDOW_MINUTES = 60;
export const SELF_HELD_MIN = 3;

export interface LaneHeldRow {
  lane: string;
  /** HELD deferrals in the window. */
  held: number;
  /** Finished jobs (published or empty) from this lane in the window. */
  finishes: number;
  selfHeld: boolean;
  /** The plain skip reason when self-held, else null. */
  reason: string | null;
}
export interface LanesHeldReport {
  schema: typeof LANES_HELD_SCHEMA;
  generatedAt: string;
  windowMinutes: number;
  /** unavailable: the event log could not be read; `lanes` is then empty, never "nothing held". */
  source: 'ok' | 'unavailable';
  malformedLines: number;
  /** Lanes with any held launch in the window, most held first. */
  lanes: LaneHeldRow[];
  selfHeld: string[];
}

const EVENT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([A-Z][A-Z0-9_-]{0,63})(?: (.*))?$/;
const ID = /^[A-Za-z0-9_.-]{1,80}$/;
const FINISH_KINDS = new Set(['PUBLISHED', 'EMPTY_DONE', 'EMPTY', 'SKIPPED-EMPTY', 'DONE-NOOP']);

export function laneHeldReason(lane: string, held: number): string {
  return `lane ${lane} holds every launch (${held} in ${LANE_HELD_WINDOW_MINUTES} min)`;
}

/** Log time is host-local with no zone; parse it as local and reject impossible dates. */
function localMs(m: RegExpExecArray): number {
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, s);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && h < 24 && mi < 60 && s < 60
    ? date.getTime() : NaN;
}

export function computeLanesHeld(text: string | null, nowMs: number): LanesHeldReport {
  const base = { schema: LANES_HELD_SCHEMA, generatedAt: new Date(nowMs).toISOString(), windowMinutes: LANE_HELD_WINDOW_MINUTES } as const;
  if (text === null) return { ...base, source: 'unavailable', malformedLines: 0, lanes: [], selfHeld: [] };
  const fromMs = nowMs - LANE_HELD_WINDOW_MINUTES * 60_000;
  const laneOf = new Map<string, string>();
  const counts = new Map<string, { held: number; finishes: number }>();
  const bump = (lane: string, key: 'held' | 'finishes'): void => {
    const row = counts.get(lane) ?? { held: 0, finishes: 0 };
    row[key]++;
    counts.set(lane, row);
  };
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = EVENT.exec(line);
    if (!m) { if (/^\d{4}-\d{2}-\d{2} /.test(line)) malformedLines++; continue; }
    const kind = m[7]!;
    if (kind !== 'LAUNCH' && kind !== 'LAUNCH_DEFERRED' && !FINISH_KINDS.has(kind)) continue;
    const ms = localMs(m);
    if (!Number.isFinite(ms)) { malformedLines++; continue; }
    const parts = m[8] ? m[8].split(/\s+/) : [];
    const job = parts[0];
    if (!job || !ID.test(job)) { malformedLines++; continue; }
    if (kind === 'LAUNCH') {
      const [, repo, lane, tier] = parts;
      if (parts.length !== 4 || !ID.test(repo!) || !ID.test(lane!) || !ID.test(tier!)) { malformedLines++; continue; }
      laneOf.set(job, lane!); // outside the window too: a held id's launch may predate it
      continue;
    }
    if (ms < fromMs || ms > nowMs) continue;
    const lane = laneOf.get(job);
    if (!lane) continue;
    if (kind === 'LAUNCH_DEFERRED') { if (parts[1] === 'HELD') bump(lane, 'held'); }
    else bump(lane, 'finishes');
  }
  const lanes: LaneHeldRow[] = [...counts].filter(([, c]) => c.held > 0).map(([lane, c]) => {
    const selfHeld = c.held >= SELF_HELD_MIN && c.finishes === 0;
    return { lane, held: c.held, finishes: c.finishes, selfHeld, reason: selfHeld ? laneHeldReason(lane, c.held) : null };
  }).sort((a, b) => b.held - a.held || a.lane.localeCompare(b.lane));
  return { ...base, source: 'ok', malformedLines, lanes, selfHeld: lanes.filter(r => r.selfHeld).map(r => r.lane) };
}

/** One plain line per lane, or one sentence when nothing is held. */
export function lanesHeldLines(report: LanesHeldReport): string[] {
  if (report.source === 'unavailable') return ['The dispatch event log is unreadable, so held launches are unknown.'];
  if (!report.lanes.length) return [`No lane has had a held launch in the last ${report.windowMinutes} min.`];
  return report.lanes.map(r => r.selfHeld
    ? `${r.lane}: ${r.reason}; skipped until a launch there finishes`
    : `${r.lane}: ${r.held} held in ${report.windowMinutes} min, ${r.finishes} finished; not self-held`);
}

/**
 * Per-lane "held" summary for `fleet lanes`: a lane can look healthy while every
 * launch on it is written as `HELD: ...` to its `<job>.launch` file. Pure: the
 * caller reads the launch files and says which lane each job belongs to.
 */

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
