/**
 * `pools.spenddown.v1`: for each plan, how much is spent, where a straight line from the last reset would be by now,
 * and where the current burn ends at reset, with a verdict in plain words. Behind `phm pools spenddown`,
 * GET /api/app/pools/spenddown, and the one-row-per-pool chart on the desktop usage panel and the phone Home.
 *
 * Derived only from pools.v1 (`buildPoolsView`), so the burn, the reset and the staleness rules are the ones
 * `phm pools` already uses; nothing here re-measures. A pool with no current reading is "no reading", never zero.
 */
import { poolLabel } from '../usage/runway.js';
import type { PoolRow, PoolsViewV1 } from './pools-view.js';

export const SPENDDOWN_SCHEMA = 'pools.spenddown.v1';
export const SPENDDOWN_PATH = '/api/app/pools/spenddown';

/** on-pace and under are the two good-to-know cases; over runs dry early; drained is empty now; unknown has no reading. */
export type SpendDownState = 'on-pace' | 'under' | 'over' | 'drained' | 'unknown';

export interface SpendDownRow {
  id: string;
  label: string;
  state: SpendDownState;
  /** Share of the window's allowance used now, 0 to 1; null without a current reading. */
  used_frac: number | null;
  reset_at: string | null;
  /** Where a straight line from the last reset would be now, 0 to 1: the bar's tick. Null when the window is unknown. */
  even_pace_frac: number | null;
  /** Share used at reset if the current burn holds, 0 to 1: the bar's marker. Null when the burn is unknown. */
  projected_at_reset: number | null;
  /** When the pool runs dry before its reset at this burn; null otherwise. */
  projected_empty_at: string | null;
  /** The whole story in plain words: "on pace", "will leave 12% unused: add work", "drained until Fri 6 PM", "no reading". */
  verdict: string;
  /** Hours until the reset, one decimal; null when the reset is unknown or already passed. */
  resets_in_h: number | null;
  /** When the plan's last reading was captured; null when none was ever recorded. */
  as_of: string | null;
  /** Minutes since that reading, whole; null when there is none or its time is not usable. */
  reading_age_min: number | null;
  /** Why there is no reading; null when there is one. */
  reason: string | null;
}

export interface SpendDownV1 {
  schema: typeof SPENDDOWN_SCHEMA;
  generated_at: string;
  /** Plans that run dry early or leave a lot unspent first, then the rest as `phm pools` orders them. */
  pools: SpendDownRow[];
}

const frac = (pct: number | null): number | null => pct === null ? null : Math.round(Math.min(100, Math.max(0, pct)) * 10) / 1000;

/** "Fri 6 PM", in the reader's own time zone. */
function dayAndHour(iso: string): string {
  const at = new Date(iso);
  return `${at.toLocaleString('en-US', { weekday: 'short' })} ${at.toLocaleString('en-US', { hour: 'numeric' })}`.replace(/\s/g, ' ');
}

/** "20 min old", "3 h old", "2 d old". */
function ageText(min: number): string {
  return min < 60 ? `${min} min old` : min < 2880 ? `${Math.round(min / 60)} h old` : `${Math.round(min / 1440)} d old`;
}

function stateOf(row: PoolRow): SpendDownState {
  if (row.usedPct === null) return 'unknown';
  if (row.verdict === 'fully used' || row.usedPct >= 100) return 'drained';
  if (row.verdict === 'slow down') return 'over';
  if (row.verdict === 'add work') return 'under';
  return row.verdict === 'on pace' ? 'on-pace' : 'unknown';
}

function verdictOf(row: PoolRow, state: SpendDownState, ageMin: number | null): string {
  switch (state) {
    case 'on-pace': return 'on pace';
    case 'under': return `will leave ${Math.round(row.projectedUnusedPct ?? 0)}% unused: add work`;
    case 'over': return `will run out ${row.projectedEmptyAt === null ? 'early' : `about ${dayAndHour(row.projectedEmptyAt)}`}: slow down`;
    case 'drained': return row.resetAt === null ? 'drained' : `drained until ${dayAndHour(row.resetAt)}`;
    case 'unknown':
      if (row.usedPct === null && ageMin !== null && row.reason?.startsWith('no reading since')) return `unknown: no fresh reading (${ageText(ageMin)})`;
      return row.usedPct === null ? 'no reading' : 'no pace yet: not enough readings';
  }
}

export function buildSpendDown(view: Pick<PoolsViewV1, 'pools' | 'generatedAt'>): SpendDownV1 {
  const nowMs = Date.parse(view.generatedAt);
  const pools = view.pools.map((row): SpendDownRow => {
    const state = stateOf(row);
    const asOfMs = row.asOf === null ? NaN : Date.parse(row.asOf);
    const ageMin = Number.isFinite(asOfMs) && Number.isFinite(nowMs) && asOfMs <= nowMs ? Math.floor((nowMs - asOfMs) / 60_000) : null;
    const resetMs = row.resetAt === null ? NaN : Date.parse(row.resetAt);
    const resetsIn = Number.isFinite(resetMs) && Number.isFinite(nowMs) && resetMs > nowMs ? Math.round((resetMs - nowMs) / 360_000) / 10 : null;
    const fully = state === 'drained';
    return {
      id: row.id, label: poolLabel(row.id), state, used_frac: frac(row.usedPct), reset_at: row.resetAt,
      even_pace_frac: frac(row.elapsedPct),
      projected_at_reset: fully ? 1 : row.projectedUnusedPct === null ? null : frac(100 - row.projectedUnusedPct),
      projected_empty_at: row.projectedEmptyAt, verdict: verdictOf(row, state, ageMin), resets_in_h: resetsIn, as_of: row.asOf, reading_age_min: ageMin, reason: row.usedPct === null ? row.reason ?? 'no reading' : row.reason,
    };
  });
  return { schema: SPENDDOWN_SCHEMA, generated_at: view.generatedAt, pools };
}

/** `phm pools spenddown --text`: one line per pool, "Claude: 72% used, 61% would be even, ends near 88%: will leave 12% unused: add work". */
export function formatSpendDownText(data: SpendDownV1): string {
  if (data.pools.length === 0) return 'No plans reported.';
  const pct = (value: number | null): string => value === null ? 'unknown' : `${Math.round(value * 100)}%`;
  return data.pools.map(row => row.used_frac === null ? `${row.label}: ${row.verdict}`
    : `${row.label}: ${pct(row.used_frac)} used, even pace ${pct(row.even_pace_frac)}, ends near ${pct(row.projected_at_reset)}: ${row.verdict}`).join('\n');
}
