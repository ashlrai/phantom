/**
 * A Capacity card's usage window in words: the lane's own row of pools.v1 (`phm pools`, GET /api/app/pools), beside
 * the slots it filled. Pure. The shares, the reset and the projection are the row's; the only figure added from the
 * card is the idle slot time of the window the board is showing. A lane the view does not list, a read that failed
 * and a row with no reading all say "usage unknown", never a percentage.
 */
import type { PoolRow, PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import { hoursUntil, poolBar, poolGroup, span, type PoolBarEnding } from '../fleet-pools/pools-board-model.js';
import { slotSpan } from './capacity-board-model.js';

/** `loading`: no answer yet. `failed`: no answer and the read threw. `stale`: an earlier answer, the refresh failed. */
export type PoolsRead = 'loading' | 'failed' | 'ok' | 'stale';

export interface LaneUsageBar {
  /** The bar read aloud. */
  words: string;
  /** Null draws the hatched track: there is no reading to draw. */
  used: number | null;
  more: number | null;
  unused: number | null;
  elapsed: number | null;
  ending: PoolBarEnding;
}

export interface LaneUsageView {
  /** `window`: a measured plan window. `unknown`: a window, or a lane, with no reading. `plain`: nothing resets. */
  kind: 'window' | 'unknown' | 'plain';
  /** The reading itself: "62% used", "usage unknown", "no usage window". */
  figure: string;
  /** What qualifies it: the reset as last reported and the reading's age. */
  meta: string[];
  /** The reset instant behind the words, for the local time shown beside them. */
  resetAt: string | null;
  bar: LaneUsageBar | null;
  /** How the window ends, set against the lane's open slots. */
  note: string | null;
  tone?: 'warning';
}

const HATCHED: LaneUsageBar = { words: 'usage unknown', used: null, more: null, unused: null, elapsed: null, ending: 'unread' };
const unknown = (note: string, meta: string[] = [], resetAt: string | null = null): LaneUsageView => ({ kind: 'unknown', figure: 'usage unknown', meta, resetAt, bar: HATCHED, note });
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** When the reading was taken, against the view's own clock; null when the row does not say. */
function readAge(row: PoolRow, view: Pick<PoolsViewV1, 'generatedAt'>): string | null {
  const age = hoursUntil(row.asOf, view);
  if (age === null || age > 0) return null;
  return -age * 60 < 1 ? 'read just now' : `read ${span(-age)} ago`;
}

function resetWords(row: PoolRow, view: Pick<PoolsViewV1, 'generatedAt'>): string {
  const until = hoursUntil(row.resetAt, view);
  return until === null ? 'reset unknown' : until > 0 ? `resets in ${span(until)}` : 'reset passed';
}

export interface LaneIdle { lane: string; idleSlotMinutes: number }

/**
 * One lane's usage block. Null while the first read is still out: the card then says it is reading.
 * `hours` is the board's history window, the span the idle slot time was counted over.
 */
export function laneUsage(lane: LaneIdle, view: PoolsViewV1 | undefined, read: PoolsRead, hours: number, localTime: (iso: string) => string): LaneUsageView | null {
  if (!view) return read === 'failed' ? unknown('phm pools could not be read.') : null;
  const row = view.pools.find(pool => pool.id === lane.lane);
  if (!row) return unknown(`phm pools does not list ${lane.lane}.`);
  const age = readAge(row, view);
  const last = read === 'stale' ? ['last reading'] : [];
  if (row.kind === 'unmetered') return { kind: 'plain', figure: 'no usage window', meta: last, resetAt: null, bar: null, note: null };
  if (row.kind === 'credits') {
    return { kind: row.creditsRemaining === null ? 'unknown' : 'plain', figure: row.creditsRemaining === null ? 'balance unknown' : `${number.format(row.creditsRemaining)} credits`,
      meta: [...(age ? [age] : []), ...last], resetAt: null, bar: null, note: row.creditsRemaining === null ? row.reason : null };
  }
  const meta = [resetWords(row, view), ...(age ? [age] : []), ...last];
  if (row.usedPct === null) return unknown(row.reason ?? 'No current reading of this window.', meta, row.resetAt);
  const shares = poolBar(row);
  const bar: LaneUsageBar = { words: shares.words, used: row.usedPct, more: shares.more, unused: shares.unused, elapsed: row.elapsedPct, ending: shares.ending };
  const base = { kind: 'window' as const, figure: `${row.usedPct}% used`, meta, resetAt: row.resetAt, bar };
  if (row.state === 'refilled') return { ...base, note: 'Its window reset and no reading has come since, so used shows 0%.' };
  if (shares.ending === 'dry') {
    return { ...base, tone: 'warning', note: row.projectedEmptyAt === null ? 'Runs empty before its reset at this burn.' : `Runs empty ${localTime(row.projectedEmptyAt)}, before its reset.` };
  }
  if (shares.ending === 'unprojected') return { ...base, note: 'No burn measured, so how the window ends is not projected.' };
  if (shares.ending === 'even') return { ...base, note: 'On pace to use its whole window by the reset.' };
  if (poolGroup(row) !== 'behind') return { ...base, note: `${shares.unused}% left at the reset at this burn.` };
  // The pairing this card exists for: allowance set to lapse while the lane's own slots sat open.
  const idle = lane.idleSlotMinutes > 0;
  return { ...base, ...(idle ? { tone: 'warning' as const } : {}),
    note: `${shares.unused}% set to go unused at the reset${idle ? `, and ${slotSpan(lane.idleSlotMinutes)} of its slots sat open in the last ${hours} h` : ''}.` };
}

/** True when some listed lane has a measured window, so the key under the heading has a bar to explain. */
export const anyMeasured = (lanes: readonly string[], view: PoolsViewV1 | undefined): boolean =>
  !!view && view.pools.some(row => row.kind === 'subscription' && row.usedPct !== null && lanes.includes(row.id));
