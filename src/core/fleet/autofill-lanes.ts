/**
 * Which lanes autofill should feed, and why each other lane is left alone.
 *
 * A lane is starved when ALL of these hold:
 *   - it is not held,
 *   - its pool has a budget reading and still has usage left (no reading is not assumed to mean usage left),
 *   - no READY row is routed to it (rows for other lanes do not count),
 *   - no lane-open READY row waits for the market to place (open supply any
 *     lane may claim keeps a free lane from reading as starved, the same rule
 *     fleet.starved's open_rows applies),
 *   - it is running fewer jobs than its target.
 * Pure: no files, no clock. The caller reads the lane facts (queue status, slot target, pool budget).
 */

export interface LaneFacts {
  lane: string;
  /** Jobs running now; null when unknown. */
  running: number | null;
  /** Slot target; null when unknown. */
  target: number | null;
  /** READY rows routed to this lane; null when unknown. */
  queued: number | null;
  held: boolean;
  /** Share of the pool still unspent (0-100); null when no budget reading exists. */
  remainingPct: number | null;
  /** When the pool refills (ISO); optional, used only to say when a spent lane is back. */
  resetAt?: string | null;
}

export interface LaneVerdict {
  lane: string;
  starved: boolean;
  /** Free slots a starved lane may be fed up to; 0 for every other lane. */
  free: number;
  /** One plain sentence: why this lane is, or is not, fed. */
  why: string;
}

export function judgeLane(f: LaneFacts, openRows: number | null = null): LaneVerdict {
  const no = (why: string): LaneVerdict => ({ lane: f.lane, starved: false, free: 0, why });
  if (f.held) return no('held, so it is skipped');
  if (f.remainingPct === null) return no('no budget reading, so usage left is unknown');
  if (f.remainingPct <= 0) return no('out of usage (pool 100% used)');
  if (f.running === null || f.target === null) return no('running count or target is unknown');
  if (f.queued === null) return no('queue depth is unknown');
  if (f.queued > 0) return no(`${f.queued} ready ${f.queued === 1 ? 'row is' : 'rows are'} already queued for it`);
  if (f.running >= f.target) return no(`full: ${f.running} of ${f.target} running`);
  // Lane-open READY rows are shared supply the market may place on this lane:
  // a positive count means the lane is not out of work. Unknown (null) credits nothing.
  if (typeof openRows === 'number' && Number.isSafeInteger(openRows) && openRows > 0) {
    return no(`${openRows} lane-open ${openRows === 1 ? 'row waits' : 'rows wait'} for any lane`);
  }
  const used = `, pool ${Math.round(100 - f.remainingPct)}% used`;
  const free = f.target - f.running;
  return { lane: f.lane, starved: true, free, why: `running ${f.running} of ${f.target}, 0 queued${used}` };
}

/** Verdicts for every lane, sorted by name. */
export function judgeLanes(facts: readonly LaneFacts[], openRows: number | null = null): LaneVerdict[] {
  return [...facts].map(f => judgeLane(f, openRows)).sort((a, b) => a.lane.localeCompare(b.lane));
}
