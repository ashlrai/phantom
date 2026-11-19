/**
 * lane-badge.ts — RQ-LANEBADGEN20OQ8: one `health` verdict per lane in the
 * lanes read, so the fleet map and the lane card can show the three states
 * that cost merges and that busy/idle hides: held, starved, wasteful (plus
 * drained, which was already visible as credit but not as a verdict).
 *
 * Pure and browser-safe. It reads only what the lanes read already carries.
 * Precedence when two apply: drained > held > starved > wasteful > ok.
 */
export const LANE_HEALTH_STATES = ['ok', 'held', 'starved', 'wasteful', 'drained'] as const;
export type LaneHealthState = (typeof LANE_HEALTH_STATES)[number];

/** Wasteful = at least this many starts in the merge window with fewer than 1 merged PR per this many starts. */
export const WASTEFUL_MIN_STARTS = 5;
export const WASTEFUL_STARTS_PER_MERGE = 5;

export interface LaneHealthInput {
  lane: string;
  /** Credit left, 0..100; null when unknown. */
  remainingPct: number | null;
  held: boolean;
  heldReason: string | null;
  /** The lane's slot target; the slots a held lane keeps from others. */
  slotTarget: number | null;
  starved: boolean;
  freeSlots: number | null;
  readyRows: number | null;
  /** ISO time the lane was first seen starved. */
  starvedSince: string | null;
  /** Jobs started and unique merged PRs inside the window; null when unknown. */
  starts: number | null;
  merged: number | null;
  windowMinutes: number;
  liveJobs: number | null;
}

export interface LaneHealth {
  state: LaneHealthState;
  /** One plain line starting with the state, e.g. "starved: 5 free slots, 0 ready rows for 40 min". */
  reason: string;
  /** The number behind the reason; null for ok when nothing is known. */
  number: number | null;
  /** Optional: the lane's top EMPTY reason in the last 24 h, e.g. "top empty reason: already-shipped (3 of 5 empty jobs)". Shown in the tooltip. */
  emptyNote?: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function minutesText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return minutes < 1 ? 'under a minute' : minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/** Plain tooltip note for a lane's top EMPTY reason; null when there is nothing to say or the reason is unknown. */
export function emptyNoteFor(top: string, count: number, total: number): string | null {
  return total > 0 && top !== 'unknown' ? `top empty reason: ${top} (${count} of ${plural(total, 'empty job', 'empty jobs')})` : null;
}

export function isWasteful(starts: number | null, merged: number | null): boolean {
  return starts !== null && merged !== null && starts >= WASTEFUL_MIN_STARTS && merged * WASTEFUL_STARTS_PER_MERGE < starts;
}

export function laneHealthFor(input: LaneHealthInput, nowMs: number): LaneHealth {
  if (input.remainingPct !== null && input.remainingPct <= 0) {
    return { state: 'drained', reason: 'drained: credit is spent, nothing launched here would run', number: 0 };
  }
  if (input.held) {
    const slots = input.slotTarget ?? 0;
    const why = input.heldReason ? ` (${input.heldReason.slice(0, 80)})` : '';
    return { state: 'held', reason: `held: keeps ${plural(slots, 'launch slot', 'launch slots')} and refuses to run${why}`, number: slots };
  }
  if (input.starved) {
    const since = input.starvedSince === null ? NaN : Date.parse(input.starvedSince);
    const age = Number.isFinite(since) && since <= nowMs ? ` for ${minutesText(nowMs - since)}` : '';
    const free = input.freeSlots ?? 0;
    return { state: 'starved', reason: `starved: ${plural(free, 'free slot', 'free slots')}, ${plural(input.readyRows ?? 0, 'ready row', 'ready rows')}${age}`, number: free };
  }
  if (isWasteful(input.starts, input.merged)) {
    const starts = input.starts ?? 0;
    return { state: 'wasteful', reason: `wasteful: ${plural(starts, 'start', 'starts')}, ${plural(input.merged ?? 0, 'merged PR', 'merged PRs')} in ${input.windowMinutes} min`, number: starts };
  }
  const live = input.liveJobs;
  return { state: 'ok', reason: live === null ? 'ok: no problem seen' : `ok: ${live} running, ${input.readyRows ?? 0} ready`, number: live };
}

/** Browser-side guard for a verdict read off the wire: anything malformed reads as "no verdict", never as ok. */
export function narrowLaneHealth(raw: unknown): LaneHealth | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const state = LANE_HEALTH_STATES.find(s => s === row.state);
  if (!state || typeof row.reason !== 'string' || row.reason === '') return undefined;
  const number = typeof row.number === 'number' && Number.isFinite(row.number) ? row.number : null;
  const emptyNote = typeof row.emptyNote === 'string' && row.emptyNote !== '' ? row.emptyNote.slice(0, 120) : undefined;
  return { state, reason: row.reason.slice(0, 200), number, ...(emptyNote ? { emptyNote } : {}) };
}
