/**
 * routes/verse/fleet-usage/usage-board-model.ts — the words and shares the
 * Usage board adds on top of the account rows: where each account stands, the
 * one-line headline, the next reset, a reset as a local clock time, and each
 * lane's share of the busiest lane's tokens. Pure. Every value comes from
 * the rows the pane already holds (GET /api/verse/accounts and
 * GET /api/verse/fleet/runs); one they do not hold is null, never zero.
 */
import type { LaneTokenRow, UsageRow } from './usage-pane-model.js';

/** Where one account stands, from its state and the windows the provider reported. */
export type AccountStanding = 'limit' | 'unread' | 'checking' | 'no-reading' | 'read';

export function accountStanding(row: Pick<UsageRow, 'state' | 'windows'>): AccountStanding {
  if (row.state === 'checking') return 'checking';
  if (row.state !== 'observed') return 'unread';
  // A provider flag, never inferred from a 100% reading: credits can keep such an account usable.
  if (row.windows.some((w) => w.limitReached)) return 'limit';
  return row.windows.some((w) => w.measured && w.usedPercent !== null) ? 'read' : 'no-reading';
}

/** One sentence over the board; null when there are no accounts to count. */
export function usageHeadline(rows: readonly Pick<UsageRow, 'state' | 'windows'>[]): string | null {
  if (rows.length === 0) return null;
  const n: Record<AccountStanding, number> = { limit: 0, unread: 0, checking: 0, 'no-reading': 0, read: 0 };
  for (const row of rows) n[accountStanding(row)] += 1;
  const parts = [
    n.limit > 0 ? `${n.limit} flagged at a limit` : '',
    n.unread > 0 ? `${n.unread} not readable` : '',
    n.checking > 0 ? `${n.checking} still checking` : '',
    n['no-reading'] > 0 ? `${n['no-reading']} with no reading` : '',
  ].filter(Boolean);
  const noun = rows.length === 1 ? '1 account' : `${rows.length} accounts`;
  return parts.length === 0 ? `${noun} read, none flagged at a limit.` : `${noun}: ${parts.join(', ')}.`;
}

export interface NextReset { account: string; window: string; resetsAt: string }

/** The soonest machine-readable reset still ahead. Prose-only resets (Claude's) carry no instant and are skipped. */
export function nextAccountReset(rows: readonly Pick<UsageRow, 'label' | 'state' | 'windows'>[], nowMs: number): NextReset | null {
  let next: (NextReset & { at: number }) | null = null;
  for (const row of rows) {
    if (row.state !== 'observed') continue;
    for (const w of row.windows) {
      const at = w.resetsAt === null ? NaN : Date.parse(w.resetsAt);
      if (!Number.isFinite(at) || at <= nowMs) continue;
      if (next === null || at < next.at) next = { account: row.label, window: w.label, resetsAt: w.resetsAt as string, at };
    }
  }
  return next === null ? null : { account: next.account, window: next.window, resetsAt: next.resetsAt };
}

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
