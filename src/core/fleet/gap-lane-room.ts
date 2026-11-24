/**
 * Where a gap job can go, and what really counts as "queued", for the gap hook.
 *
 * A READY row on a held lane, or on a lane whose pool is used up, cannot launch, so it
 * must not make the queue look full. A lane has room when it is not held, its pool has usage
 * left, and its target minus running minus queued is above zero. Pure: the caller reads the
 * lanes (the same readings `phm pools` and `phm fleet lane-supply` show).
 */
import type { LaneFacts } from './autofill-lanes.js';
import { POOL_USED_UP_PCT } from './lane-pool-wait.js';
import { aheadWords, type PaceVerdict } from './pace-verdict.js';

/** A lane that can take new gap work now. */
export interface GapLaneOpen { lane: string; free: number; running: number; target: number }
/** A lane with queued rows that cannot launch yet. */
export interface GapLaneWaiting { lane: string; rows: number; why: 'held' | 'out of usage' | 'no free slot'; backAt: string | null }
export interface GapLaneRoom {
  live?: ReadonlySet<string>;
  open: GapLaneOpen[];
  waiting: GapLaneWaiting[];
  /** Queued rows that cannot launch now (the sum of `waiting`); the queue-full check subtracts them. */
  stuck: number;
}

/** Lanes a gap job may be written for, best first: claude needs no gh, so it goes first. */
export const GAP_LANE_ORDER = ['claude', 'codex-local', 'codex-personal'] as const;

export function gapLaneRoom(lanes: readonly LaneFacts[], nowMs: number): GapLaneRoom {
  const room: GapLaneRoom = { open: [], waiting: [], stuck: 0, live: new Set(lanes.map(f => f.lane)) };
  for (const f of lanes) {
    const spent = f.remainingPct !== null && 100 - f.remainingPct >= POOL_USED_UP_PCT;
    const back = f.resetAt ? Date.parse(f.resetAt) : NaN;
    // A reset already past means the reading is stale, so the pool is not treated as used up.
    if (spent && Number.isFinite(back) && back <= nowMs) { addOpen(room, f); continue; }
    if (f.held || spent) {
      if (f.queued) {
        room.waiting.push({ lane: f.lane, rows: f.queued, why: f.held ? 'held' : 'out of usage', backAt: Number.isFinite(back) && spent ? new Date(back).toISOString() : null });
        room.stuck += f.queued;
      }
      continue;
    }
    // Every slot busy: its queued rows wait for a slot, so they cannot make the queue look full either.
    if (f.queued && f.running !== null && f.target !== null && f.running >= f.target) {
      room.waiting.push({ lane: f.lane, rows: f.queued, why: 'no free slot', backAt: null });
      room.stuck += f.queued;
      continue;
    }
    addOpen(room, f);
  }
  return room;
}

function addOpen(room: GapLaneRoom, f: LaneFacts): void {
  if (f.running === null || f.target === null) return;
  const free = f.target - f.running - (f.queued ?? 0);
  if (free > 0) room.open.push({ lane: f.lane, free, running: f.running, target: f.target });
}

/** Plain words for the gap hook note: "10 rows parked on codex-personal (pool spent until Sat 3:30 PM)". */
export function parkedWords(waiting: readonly GapLaneWaiting[]): string {
  return waiting.map(w => `${w.rows} ${w.rows === 1 ? 'row' : 'rows'} parked on ${w.lane} (${w.why === 'held' ? 'lane held' : w.why === 'no free slot' ? 'every slot busy' : w.backAt ? `pool spent until ${when(w.backAt)}` : 'pool spent'})`).join('; ');
}

/** "Sat 3:30 PM" in the reader's zone. */
const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Pick the lane for one gap: gh work only on codex-personal, everything else the best open lane. Null when none has room. */
export function pickGapLane(room: GapLaneRoom, needsGh: boolean): string | null {
  const order = needsGh ? ['codex-personal'] : GAP_LANE_ORDER;
  return order.find(lane => room.open.some(o => o.lane === lane && o.free > 0)) ?? null;
}

/** What pace did to one pick: the lane to use (null = hold), the lane pace moved it off (or preferred over), and why pace held it. */
export interface PacedPick { lane: string | null; heldWhy: string | null; from: string | null }

/**
 * Pick the lane for one gap with pace: an "ahead" pool gets no new rows, a "behind" pool goes first,
 * "unknown" or missing pace changes nothing. Eligibility is unchanged (gh work only on codex-personal).
 * `heldWhy` is set when pace is the reason no lane was picked.
 */
export function pickPacedLane(room: GapLaneRoom, needsGh: boolean, pace: ReadonlyMap<string, PaceVerdict> | undefined): PacedPick {
  const plain = pickGapLane(room, needsGh);
  if (!pace || pace.size === 0) return { lane: plain, heldWhy: null, from: null };
  const order = needsGh ? ['codex-personal'] : [...GAP_LANE_ORDER];
  const open = order.filter(lane => room.open.some(o => o.lane === lane && o.free > 0));
  const ahead = open.filter(lane => pace.get(lane)?.state === 'ahead' || pace.get(lane)?.verdict === 'over');
  const usable = open.filter(lane => !ahead.includes(lane));
  const rank = (lane: string): number => (pace.get(lane)?.state === 'behind' ? 0 : 1);
  usable.sort((a, b) => rank(a) - rank(b));
  const lane = usable[0] ?? null;
  const skipped = plain !== null && ahead.includes(plain) ? plain : null;
  if (lane === null && ahead.length) return { lane, heldWhy: `${aheadWords(pace.get(ahead[0]!)!)}, and no other pool with room can take it`, from: ahead[0]! };
  return { lane, heldWhy: null, from: skipped ?? (lane !== null && lane !== plain && pace.get(lane)?.state === 'behind' ? plain : null) };
}
