/**
 * components/notifications/reset-waste-model.ts — pure projection of how much
 * of a lane's usage window will still be unused when it resets.
 *
 * The resource ledger already reports each lane's window, percent used,
 * credit balance, reset time and burn rate. A lane that reaches reset with
 * most of its window unspent is wasted capacity the fleet could have used —
 * the "zero waste" case. This model turns one ledger row into that verdict;
 * the bell deriver (deriveFleetLedgerNotifications.ts) lifts 'wasting' lanes
 * into notifications.
 *
 * Pure: `nowMs` is a parameter, never Date.now — the engine passes its own
 * clock so derivers and tests share one "now" per poll cycle.
 */
import type { ResourceLaneRow } from '../../routes/verse/usage/fleet-ledger-model.js';

export interface ResetWasteProjection {
  /** 'unknown' when the row can't support a verdict (no reset, no percent
   * reading); 'wasting' when the reset is close and a large share will go
   * unused; 'on-track' otherwise. */
  state: 'unknown' | 'on-track' | 'wasting';
  /** Hours until the window resets, clamped at 0; null when resetAt is
   * missing or unparseable. */
  hoursToReset: number | null;
  /** Percent of the window currently unused; null when the row reports no
   * percent (absolute credit balances aren't percents). */
  unusedPct: number | null;
  /** Percent still unused at reset given the current burn rate; null when
   * either input is missing. */
  projectedUnusedPct: number | null;
  /** Dispatch slots doing nothing (target - running); null unless both are
   * reported. */
  idleSlots: number | null;
}

const HOUR_MS = 3_600_000;
/** Reset horizons beyond a day aren't urgent enough to warn about. */
export const RESET_WASTE_WINDOW_HOURS = 24;
/** Below this share of projected waste the bell stays quiet. */
export const RESET_WASTE_MIN_UNUSED_PCT = 25;

const finite = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Unused percent of the lane's window. Weekly windows report `usedPct`
 * directly. Credits lanes only yield a percent when the row gives one —
 * `usedPct` is authoritative when present; `creditsRemaining` counts as a
 * percent only when it reads like one (0-100), never an absolute balance.
 * Where both readings exist they should agree, and the lower one is the
 * honest answer.
 */
function unusedPctOf(lane: ResourceLaneRow): number | null {
  const fromUsed = finite(lane.usedPct) ? Math.max(0, 100 - lane.usedPct) : null;
  if (lane.window === 'weekly') return fromUsed;
  if (lane.window !== 'credits') return null;
  const fromCredits = finite(lane.creditsRemaining) && lane.creditsRemaining <= 100 ? lane.creditsRemaining : null;
  if (fromUsed === null) return fromCredits;
  return fromCredits === null ? fromUsed : Math.min(fromUsed, fromCredits);
}

export function projectResetWaste(lane: ResourceLaneRow, nowMs: number): ResetWasteProjection {
  const resetMs = lane.resetAt === null ? NaN : Date.parse(lane.resetAt);
  const hoursToReset = Number.isFinite(resetMs) && Number.isFinite(nowMs)
    ? Math.max(0, (resetMs - nowMs) / HOUR_MS) : null;
  const unusedPct = unusedPctOf(lane);
  const burn = finite(lane.burnPctPerHour) ? lane.burnPctPerHour : 0;
  const projectedUnusedPct = unusedPct !== null && hoursToReset !== null
    ? Math.max(0, unusedPct - burn * hoursToReset) : null;
  const idleSlots = finite(lane.running) && finite(lane.target) ? lane.target - lane.running : null;
  const state: ResetWasteProjection['state'] = hoursToReset === null || projectedUnusedPct === null
    ? 'unknown'
    : hoursToReset <= RESET_WASTE_WINDOW_HOURS && projectedUnusedPct >= RESET_WASTE_MIN_UNUSED_PCT
      ? 'wasting' : 'on-track';
  return { state, hoursToReset, unusedPct, projectedUnusedPct, idleSlots };
}
