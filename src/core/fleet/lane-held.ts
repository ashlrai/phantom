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
