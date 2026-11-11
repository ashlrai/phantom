/**
 * routes/show/show-model.ts — pure projections for Show mode's ambient layer.
 *
 * Everything here is derived from rows the read API already returned
 * (journal entries, fleet lanes). Nothing is estimated or defaulted: a lane
 * without an observed remaining percentage yields a gauge with `pct: null`
 * (rendered as text, no bar), and an empty source yields an empty list.
 */
import type { FleetLaneSnapshot } from '../../data/api-types.js';
import type { JournalEntry } from '../journal/journal-model.js';

export const FEED_LIMIT = 12;
export const WINS_LIMIT = 8;

/** Journal status labels that mean something concrete landed or was proven. */
const WIN_STATUSES = new Set(['merged', 'verified', 'proposal-created', 'done']);

/** Wins: merges plus verified/completed/proposal-producing work. */
export function buildWins(entries: JournalEntry[], limit = WINS_LIMIT): JournalEntry[] {
  return entries
    .filter(e => e.source === 'merge' || ((e.source === 'agent-action' || e.source === 'run') && WIN_STATUSES.has(e.statusLabel)))
    .slice(0, limit);
}

export interface QuotaGauge {
  lane: string;
  /** Observed remaining percent clamped to 0–100, or null when the lane reports none. */
  pct: number | null;
  label: string;
  resetAt: string | null;
  held: boolean;
}

/** One gauge per lane that reports an observed or reset-pending credit; unknown lanes are omitted. */
export function buildQuotaGauges(snapshot: FleetLaneSnapshot | undefined): QuotaGauge[] {
  return (snapshot?.lanes ?? [])
    .filter(lane => lane.credit.state !== 'unknown')
    .map(lane => ({
      lane: lane.lane,
      pct: lane.credit.remainingPct === null ? null : Math.min(100, Math.max(0, lane.credit.remainingPct)),
      label: lane.credit.label,
      resetAt: lane.credit.resetAt,
      held: lane.hold?.held === true,
    }));
}
