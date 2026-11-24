/**
 * routes/verse/home/pool-ending-model.ts: how each pool on Home's resource bar
 * ends its window at the measured burn, from the same `phm pools runway --json`
 * rows the tiles already read (GET /api/usage/runway, pool.runway.v1).
 *
 * Pure, and it decides nothing: the verdict is the row's own `state`, the share
 * left over is its `unusedAtResetPercent`, the hours it sits empty are its
 * `idleHours`. A row the server could not project stays unprojected with the
 * server's reason, and a pool with no usage reading has no bar to split.
 */
import type { PoolRunway } from '../../../../core/usage/runway.js';

/**
 * `unused`: resets with usage left. `dry`: empty before its reset. `even`: used
 * up right at its reset. `unprojected`: usage is read but the server projects
 * nothing. `unread`: no usage reading at all.
 */
export type EndingKind = 'unused' | 'dry' | 'even' | 'unprojected' | 'unread';

export interface PoolEnding {
  kind: EndingKind;
  /** Share of the window used so far, 0 to 100; null when unread. */
  used: number | null;
  /** Further share the measured burn uses before the reset; null when nothing is projected. */
  more: number | null;
  /** Share still unused at the reset; null when nothing is projected. */
  unused: number | null;
  /** The tile's line. Null when the tile already says everything known (no usage reading). */
  words: string | null;
  /** The bar read aloud. */
  meter: string;
}

const measured = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
/** "40 min", "5 h": the tile's own way of writing a wait. */
export const poolHours = (n: number): string => n < 1 ? `${Math.max(1, Math.round(n * 60))} min` : `${Math.round(n)} h`;
const share = (n: number): string => Math.round(n) < 1 ? 'under 1%' : `${Math.round(n)}%`;

export function poolEnding(row?: PoolRunway): PoolEnding {
  const reading = row?.usedPercent;
  if (!row || !measured(reading)) return { kind: 'unread', used: null, more: null, unused: null, words: null, meter: 'unknown' };
  const used = Math.min(100, reading);
  const left = 100 - used;
  const usedWords = `${Math.round(used)}% used`;
  const unprojected = (why: string): PoolEnding =>
    ({ kind: 'unprojected', used, more: null, unused: null, words: `not projected: ${why}`, meter: `${usedWords}, the rest not projected: ${why}` });
  if (row.state === 'unknown') return unprojected(row.reason ?? 'a reading is missing');
  if (row.state === 'starve') {
    const idle = row.idleHours;
    // A pool already at its limit is idle; one still burning will run dry.
    const words = measured(idle) ? `${left === 0 ? 'idle' : 'dry'} ${poolHours(idle)} before its reset` : 'dry before its reset';
    return { kind: 'dry', used, more: left, unused: 0, words, meter: `${usedWords}, ${words}` };
  }
  if (!measured(row.unusedAtResetPercent)) return unprojected('the unused share was not reported');
  const unused = Math.min(left, row.unusedAtResetPercent);
  const more = left - unused;
  if (row.state === 'pace') return { kind: 'even', used, more, unused, words: 'on pace to use it all', meter: `${usedWords}, on pace to use it all by its reset` };
  const words = `${share(unused)} unused at its reset`;
  return { kind: 'unused', used, more, unused, words, meter: `${usedWords}, ${share(more)} more by its reset, ${words}` };
}

export interface EndingSummary {
  /** One sentence counting how the pools end their windows. */
  text: string;
  /** At least one pool is projected, so the bars need their key. */
  projected: boolean;
}

/** Counts the bar's pools by how they end. A pool with no row counts as not projected, never as lasting. */
export function endingSummary(rows: ReadonlyArray<PoolRunway | undefined>): EndingSummary {
  const count = (...kinds: EndingKind[]): number => rows.filter(row => kinds.includes(poolEnding(row).kind)).length;
  const unused = count('unused'), dry = count('dry'), even = count('even'), none = count('unprojected', 'unread');
  if (unused + dry + even === 0) return { text: 'No pool can be projected: each lacks a usage, burn or reset reading.', projected: false };
  const parts: string[] = [];
  if (dry > 0) parts.push(`${dry} ${dry === 1 ? 'runs' : 'run'} dry early`);
  if (unused > 0) parts.push(`${unused} ${unused === 1 ? 'leaves' : 'leave'} usage unused`);
  if (even > 0) parts.push(`${even} on pace`);
  if (none > 0) parts.push(`${none} not projected`);
  return { text: `At this burn: ${parts.join(', ')}.`, projected: true };
}
