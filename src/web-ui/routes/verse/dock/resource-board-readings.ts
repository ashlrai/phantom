/**
 * routes/verse/dock/resource-board-readings.ts — the few words the switcher shows beside a board's name, so the
 * row says where to look before a board is opened. Each comes from the read its own board draws from and is
 * counted by that board's model, so the row and the board cannot disagree. A board whose read has not answered,
 * or has nothing worth a word, gets no reading: the name stands alone, never a zero.
 *
 * Pure; no React.
 */
import type { PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import { standingCounts, usageHeadline } from '../../../../core/usage/account-limits.js';
import { boardHeadline } from '../fleet-lanes/lanes-board-model.js';
import { poolCounts, poolsHeadline } from '../fleet-pools/pools-board-model.js';
import type { UsageRow } from '../fleet-usage/usage-pane-model.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';

export interface BoardReading {
  /** Two or three words drawn after the name. */
  readonly text: string;
  /** `attention` asks to be looked at; `quiet` is a plain figure. */
  readonly tone: 'attention' | 'quiet';
  /** The board's own headline sentence, for the tooltip. */
  readonly detail: string;
}

/**
 * Pools that run empty before their reset, else pools behind their window, else pools with no current reading;
 * nothing while every pool is on pace.
 */
export function poolsReading(view: PoolsViewV1): BoardReading | null {
  const { all, fast, behind, unknown } = poolCounts(view.pools);
  if (all === 0 || (fast === 0 && behind === 0 && unknown === 0)) return null;
  const detail = poolsHeadline(view.pools);
  if (fast > 0) return { text: `${fast} too fast`, tone: 'attention', detail };
  return behind > 0 ? { text: `${behind} behind`, tone: 'attention', detail } : { text: `${unknown} unknown`, tone: 'quiet', detail };
}

/**
 * Accounts their provider flags at a limit, else accounts that could not be read; nothing while every account
 * answered and none is flagged. The flag is the provider's own, never inferred from a 100% reading.
 */
export function usageReading(rows: readonly UsageRow[]): BoardReading | null {
  const detail = usageHeadline(rows);
  if (detail === null) return null;
  const { limit, unread } = standingCounts(rows);
  if (limit > 0) return { text: `${limit} at limit`, tone: 'attention', detail };
  return unread > 0 ? { text: `${unread} unread`, tone: 'quiet', detail } : null;
}

/** Lanes held, else slots running against slots asked for. */
export function lanesReading(runs: FleetRuns): BoardReading | null {
  if (runs.lanes.length === 0) return null;
  const detail = boardHeadline(runs);
  const held = runs.lanes.filter(lane => lane.held).length;
  if (held > 0) return { text: `${held} held`, tone: 'attention', detail };
  const whole = (value: number): number => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const running = runs.lanes.reduce((sum, lane) => sum + whole(lane.running), 0);
  const target = runs.lanes.reduce((sum, lane) => sum + whole(lane.target), 0);
  return { text: `${running}/${target}`, tone: 'quiet', detail };
}
