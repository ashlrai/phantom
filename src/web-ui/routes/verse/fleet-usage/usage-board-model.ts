/**
 * routes/verse/fleet-usage/usage-board-model.ts — the words and shares the
 * Usage board adds on top of the account rows. Where each account stands, the
 * headline and the next reset come from core (the same functions behind
 * `phm usage limits`); this file adds a reset as a local clock time and each
 * lane's share of the busiest lane's tokens. Pure. Every value comes from
 * the rows the pane already holds (GET /api/verse/accounts and
 * GET /api/verse/fleet/runs); one they do not hold is null, never zero.
 */
import type { LaneTokenRow } from './usage-pane-model.js';

export { accountStanding, nextAccountReset, usageHeadline } from '../../../../core/usage/account-limits.js';
export type { AccountStanding, NextReset } from '../../../../core/usage/account-limits.js';

const DAY_MS = 86_400_000;

/**
 * A reset instant as a local clock time beside its countdown: weekday and
 * time inside six days (a weekly window never repeats a weekday), month and
 * day beyond. Null when there is no instant or it has passed.
 */
export function resetLocalTime(iso: string | null, nowMs: number): string | null {
  const at = iso === null ? NaN : Date.parse(iso);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  return new Date(at).toLocaleString(undefined, at - nowMs < 6 * DAY_MS
    ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export interface LaneTotals { total: number | null; read: number; unread: number }

/** Tokens across the lanes that reported a figure, and how many did not. No reading anywhere is null, not 0. */
export function laneTotals(lanes: readonly LaneTokenRow[]): LaneTotals {
  const readings = lanes.flatMap((lane) => (lane.tokensLastHour === null ? [] : [lane.tokensLastHour]));
  return {
    total: readings.length === 0 ? null : readings.reduce((sum, value) => sum + value, 0),
    read: readings.length,
    unread: lanes.length - readings.length,
  };
}

/** A lane's tokens as a percent of the busiest lane's, for its bar. Null (no bar) without a reading or when nothing burned. */
export function laneSharePct(lane: LaneTokenRow, lanes: readonly LaneTokenRow[]): number | null {
  const max = Math.max(0, ...lanes.map((entry) => entry.tokensLastHour ?? 0));
  if (lane.tokensLastHour === null || max <= 0) return null;
  return Math.round(Math.max(0, lane.tokensLastHour) / max * 1000) / 10;
}
