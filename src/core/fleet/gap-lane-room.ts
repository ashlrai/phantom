/**
 * Where a gap job can go, and what really counts as "queued", for the gap hook.
 *
 * A READY row on a held lane, or on a lane whose pool is used up, cannot launch, so it
 * must not make the queue look full. A lane has room when it is not held, its pool has usage
 * left, and its target minus running minus queued is above zero. Pure: the caller reads the
 * lanes (the same readings `phm pools` and `phm fleet lane-supply` show).
 */
import type { LaneFacts } from './autofill-lanes.js';

/** A lane that can take new gap work now. */
export interface GapLaneOpen { lane: string; free: number; running: number; target: number }
/** A lane with queued rows that cannot launch yet. */
export interface GapLaneWaiting { lane: string; rows: number; why: 'held' | 'out of usage'; backAt: string | null }
export interface GapLaneRoom {
  open: GapLaneOpen[];
  waiting: GapLaneWaiting[];
  /** Queued rows that cannot launch now (the sum of `waiting`); the queue-full check subtracts them. */
  stuck: number;
}

/** Lanes a gap job may be written for, best first: claude needs no gh, so it goes first. */
export const GAP_LANE_ORDER = ['claude', 'codex-local', 'codex-personal'] as const;

export function gapLaneRoom(lanes: readonly LaneFacts[], nowMs: number): GapLaneRoom {
  const room: GapLaneRoom = { open: [], waiting: [], stuck: 0 };
  for (const f of lanes) {
    const spent = f.remainingPct !== null && f.remainingPct <= 0;
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
    addOpen(room, f);
  }
  return room;
}

function addOpen(room: GapLaneRoom, f: LaneFacts): void {
  if (f.running === null || f.target === null) return;
  const free = f.target - f.running - (f.queued ?? 0);
  if (free > 0) room.open.push({ lane: f.lane, free, running: f.running, target: f.target });
}

/** "Sat 3:30 PM" in the reader's zone. */
const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** Plain words for rows that wait: "10 rows wait on codex-personal (back Sat 3:30 PM)". */
export function waitingWords(waiting: readonly GapLaneWaiting[]): string {
  return waiting.map(w => `${w.rows} ${w.rows === 1 ? 'row waits' : 'rows wait'} on ${w.lane} (${w.why === 'held' ? 'held' : w.backAt ? `back ${when(w.backAt)}` : 'out of usage'})`).join('; ');
}

/** Pick the lane for one gap: gh work only on codex-personal, everything else the best open lane. Null when none has room. */
export function pickGapLane(room: GapLaneRoom, needsGh: boolean): string | null {
  const order = needsGh ? ['codex-personal'] : GAP_LANE_ORDER;
  return order.find(lane => room.open.some(o => o.lane === lane && o.free > 0)) ?? null;
}
