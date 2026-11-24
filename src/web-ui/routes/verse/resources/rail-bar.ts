/**
 * routes/verse/resources/rail-bar.ts: what one row of the rail's resource bar draws on the shared WindowBar.
 * The rail used to draw a battery of what was LEFT, coloured by a verdict; every other resource surface draws
 * what is USED on one bar, so the rail does too and a glance reads the same way everywhere.
 *
 * Pure, and it only restates what the row already knows:
 *   - no reading, or a reading that is no longer current, is a hatched bar with no number, whatever it last said;
 *   - nothing left on a row that is out is a full red bar: the provider's limit, flagged or measured;
 *   - a held share (Devin's exposure for sessions still running) is drawn lighter after the reported use,
 *     and is never counted as used;
 *   - the reserve and the time gone are passed through only when the row has a current measured reading.
 */

export type RailLevel = 'ok' | 'low' | 'out' | 'idle' | 'unknown';

export interface RailBarInput {
  /** 0 to 100 left of the window or budget; null = no reading. */
  left: number | null;
  level: RailLevel;
  /** False when the reading is retained from an earlier check: it may describe another window. Default true. */
  current?: boolean;
  /** Share of the whole held for work in flight, 0 to 100; null = the source does not split it out. */
  held?: number | null;
  /** Share kept back at the window's end; null or 0 = none. */
  kept?: number | null;
  /** Share of the window's time already gone; null = the window's start is not known. */
  elapsed?: number | null;
}

export interface RailBar {
  used: number | null;
  /** The held share, drawn lighter; null when there is none to draw. */
  more: number | null;
  kept: number | null;
  elapsed: number | null;
  ending: 'open' | 'spent' | 'unread';
  /** The number a screen reader gets: the share not available. Null when unread or flagged spent. */
  valueNow: number | null;
}

const UNREAD: RailBar = { used: null, more: null, kept: null, elapsed: null, ending: 'unread', valueNow: null };

const share = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;

export function railBar(input: RailBarInput): RailBar {
  const left = share(input.left);
  if (left === null || input.current === false) return UNREAD;
  const taken = 100 - left;
  const held = share(input.held);
  const spent = left === 0 && input.level === 'out';
  if (held !== null) {
    const more = Math.min(held, taken);
    return { used: taken - more, more: more > 0 ? more : null, kept: null, elapsed: null, ending: spent ? 'spent' : 'open', valueNow: taken };
  }
  if (spent) return { used: 100, more: null, kept: null, elapsed: null, ending: 'spent', valueNow: null };
  const kept = share(input.kept);
  return { used: taken, more: null, kept: kept !== null && kept > 0 ? kept : null, elapsed: share(input.elapsed), ending: 'open', valueNow: taken };
}

/** Whether a row is metered at all. Local models run on this Mac: readiness, not a usage window. */
export const railMetered = (engine: string): boolean => engine !== 'local';
