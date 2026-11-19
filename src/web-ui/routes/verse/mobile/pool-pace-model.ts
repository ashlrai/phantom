/**
 * The pool verdicts the phone Home shows: the same plain words `phm pools` prints ("Claude: empty about 3 PM Thu,
 * 27 h before reset: slow down"), taken from pools.v1 and never reworded here. Only pools that need a decision
 * are listed; a pool with no current reading is not a verdict.
 */
import type { PoolRow, PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import type { Tone } from './ui-parts.js';

export interface PoolPaceLine { id: string; words: string; tone: Tone }

const TONE: Partial<Record<PoolRow['verdict'], Tone>> = { 'slow down': 'danger', 'add work': 'warning', 'not enough readings': 'neutral' };

export function poolPaceLines(view: Pick<PoolsViewV1, 'pools'> | null | undefined): PoolPaceLine[] {
  if (!view || !Array.isArray(view.pools)) return [];
  return view.pools.flatMap(row => {
    const tone = row.verdict === undefined ? undefined : TONE[row.verdict];
    return tone === undefined ? [] : [{ id: row.id, words: row.summary, tone }];
  });
}
