/**
 * core/fleet/lane-empty-streak.ts — name lanes whose recent launches all end
 * empty. Pure projection over dispatch-events.log text: no IO, no mutation,
 * no dispatch authority. Backs `ashlr fleet lane-streaks`
 * (src/cli/fleet-lane-streaks.ts) and
 * `GET /api/verse/runs-history/lane-streaks` (core/verse/runs-history-api.ts).
 *
 * A job counts against its lane when it was LAUNCHed inside the window; its
 * outcome is the first terminal event after the launch line — PUBLISHED is
 * published, EMPTY/EMPTY_DONE/SKIPPED-EMPTY/DONE-NOOP are empty, and no
 * terminal yet is still running.
 *
 *   burning  launches >= 3, ended >= 3, nothing published, >= 80% empty
 *   quiet    no launches inside the window
 *   ok       anything else
 *
 * Rows carry counts, job ids and timestamps only — never paths, prompts or
 * lane reasons. Detection only: a later job turns `burning` into a lane hold.
 */
export interface LaneStreak {
  lane: string;
  launches: number;
  ended: number;
  empties: number;
  published: number;
  running: number;
  /** Median launch-to-terminal minutes; null when nothing has ended. */
  medianMinutes: number | null;
  verdict: 'burning' | 'quiet' | 'ok';
  lastEmptyJob: string | null;
  /** ISO instant of the newest empty terminal (`YYYY-MM-DDTHH:MM:SSZ`). */
  lastEmptyAt: string | null;
}
export interface LaneEmptyStreaksV1 {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'unavailable';
  windowMinutes: number;
  lanes: LaneStreak[];
  /** Event-shaped lines skipped for bad names or a bad timestamp. */
  malformedLines: number;
}

export const LANE_STREAKS_DEFAULT_MINUTES = 90;
export const LANE_STREAKS_MIN_MINUTES = 15;
export const LANE_STREAKS_MAX_MINUTES = 1440;
/** Below three launches an all-empty streak is noise, not a verdict. */
const BURNING_MIN_LAUNCHES = 3;
const BURNING_EMPTY_RATIO = 0.8;

const EVENT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z][A-Z0-9_-]{0,63})(?: (.*))?$/;
const ID = /^[A-Za-z0-9_.-]{1,80}$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const EMPTY_KINDS = new Set(['EMPTY_DONE', 'EMPTY', 'SKIPPED-EMPTY', 'DONE-NOOP']);
const TRACKED = new Set(['LAUNCH', 'PUBLISHED', ...EMPTY_KINDS]);

interface Launch {
  job: string;
  lane: string;
  ms: number;
  endMs?: number;
  endAt?: string;
  empty?: boolean;
}

/** Same wall-time-as-UTC convention as parseDispatchEvents: the log's local
 *  timestamps carry no zone, so `...Z` keeps every row on one clock. */
function eventMs(date: string, clock: string): number {
  if (!CLOCK.test(clock)
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return NaN;
  return Date.parse(`${date}T${clock}Z`);
}

export function laneEmptyStreaks(text: string, nowMs: number, windowMinutes = LANE_STREAKS_DEFAULT_MINUTES): LaneEmptyStreaksV1 {
  const minutes = Number.isFinite(windowMinutes)
    ? Math.min(LANE_STREAKS_MAX_MINUTES, Math.max(LANE_STREAKS_MIN_MINUTES, Math.floor(windowMinutes)))
    : LANE_STREAKS_DEFAULT_MINUTES;
  const cutoff = nowMs - minutes * 60_000;
  const launches = new Map<string, Launch[]>();
  const all: Launch[] = [];
  let malformedLines = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = EVENT.exec(line);
    if (!m) {
      // A timestamped row that fails the event shape is corrupt; unrelated
      // non-event text (a partial append) is simply not evidence.
      if (/^\d{4}-\d{2}-\d{2} /.test(line)) malformedLines++;
      continue;
    }
    const ms = eventMs(m[1]!, m[2]!);
    if (!Number.isFinite(ms)) { malformedLines++; continue; }
    const kind = m[3]!;
    if (!TRACKED.has(kind)) continue;
    const parts = m[4] ? m[4].split(/\s+/) : [];
    if (kind === 'LAUNCH') {
      const [job, repo, lane, tier] = parts;
      if (parts.length !== 4 || !ID.test(job!) || !ID.test(repo!) || !ID.test(lane!) || !ID.test(tier!)) {
        malformedLines++;
        continue;
      }
      if (ms < cutoff || ms > nowMs) continue;
      const launch: Launch = { job: job!, lane: lane!, ms };
      all.push(launch);
      const jobs = launches.get(job!) ?? [];
      jobs.push(launch);
      launches.set(job!, jobs);
      continue;
    }
    const job = parts[0];
    if (!job || !ID.test(job) || (kind === 'PUBLISHED' && parts.length < 2)) {
      malformedLines++;
      continue;
    }
    // First terminal after the launch wins; FIFO when a job id relaunched.
    const launch = launches.get(job)?.find(candidate => candidate.endMs === undefined);
    if (!launch) continue;
    launch.endMs = ms;
    launch.endAt = `${m[1]}T${m[2]}Z`;
    launch.empty = kind !== 'PUBLISHED';
  }

  const byLane = new Map<string, Launch[]>();
  for (const launch of all) {
    const rows = byLane.get(launch.lane) ?? [];
    rows.push(launch);
    byLane.set(launch.lane, rows);
  }
  const lanes: LaneStreak[] = [];
  for (const [lane, rows] of byLane) {
    const ended = rows.filter(launch => launch.endMs !== undefined);
    const empties = ended.filter(launch => launch.empty);
    const published = ended.filter(launch => launch.empty === false);
    const durations = ended.map(launch => Math.max(0, launch.endMs! - launch.ms) / 60_000).sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    const medianMinutes = durations.length
      ? Math.round((durations.length % 2 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2) * 10) / 10
      : null;
    const lastEmpty = empties.reduce<Launch | undefined>((best, launch) =>
      !best || launch.endMs! >= best.endMs! ? launch : best, undefined);
    const verdict: LaneStreak['verdict'] =
      rows.length === 0 ? 'quiet'
      : rows.length >= BURNING_MIN_LAUNCHES && ended.length >= BURNING_MIN_LAUNCHES
          && published.length === 0 && empties.length / ended.length >= BURNING_EMPTY_RATIO
        ? 'burning'
        : 'ok';
    lanes.push({
      lane,
      launches: rows.length,
      ended: ended.length,
      empties: empties.length,
      published: published.length,
      running: rows.length - ended.length,
      medianMinutes,
      verdict,
      lastEmptyJob: lastEmpty?.job ?? null,
      lastEmptyAt: lastEmpty?.endAt ?? null,
    });
  }
  lanes.sort((a, b) =>
    Number(b.verdict === 'burning') - Number(a.verdict === 'burning')
    || b.launches - a.launches || a.lane.localeCompare(b.lane));

  return {
    v: 1,
    generatedAt: new Date(nowMs).toISOString(),
    source: 'ok',
    windowMinutes: minutes,
    lanes,
    malformedLines,
  };
}
