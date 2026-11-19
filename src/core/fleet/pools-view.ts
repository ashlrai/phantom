/**
 * `pools.v1`: the zero-waste read of the resource ledger. One row per resource
 * with how much is used, when it resets, and how much would go unused at the
 * current burn. Behind `phm pools`, GET /api/app/pools and the Pools pane.
 *
 * Pure and browser-safe (type-only imports): it derives from ResourceLedgerV1
 * and keeps no state of its own. A stale or missing reading is unknown with a
 * reason, never zero.
 */
import type { ResourceLaneRow, ResourceLedgerV1 } from './runs-resource-ledger.js';

export const POOLS_SCHEMA = 'pools.v1';
export const POOLS_PATH = '/api/app/pools';
/** A usage reading older than this no longer describes the pool. */
export const POOLS_STALE_AFTER_MINUTES = 60;
/** Ledger lanes with a `weekly` window reset every seven days. */
const WEEK_HOURS = 168;
const HOUR_MS = 3_600_000;

export type PoolWasteRisk = 'high' | 'medium' | 'low' | 'unknown';
/** One narrower window inside a pool (Claude meters some models on their own weekly window). */
export interface PoolScope {
  id: string;
  /** Null once this window's reset has passed: the old percentage no longer describes it. */
  usedPct: number | null;
  resetAt: string | null;
  hoursLeft: number | null;
}
export interface PoolRow {
  id: string;
  kind: 'subscription' | 'credits' | 'unmetered';
  usedPct: number | null;
  /** Reset or expiry time as last reported; may be in the past for an expired window. */
  resetAt: string | null;
  hoursLeft: number | null;
  /** Share of the window already elapsed; the bar's time marker. */
  elapsedPct: number | null;
  burnPctPerHour: number | null;
  /** `window-average` is used percent over elapsed hours when the ledger reports no burn. */
  burnBasis: 'reported' | 'window-average' | 'held' | null;
  projectedUnusedPct: number | null;
  wasteRisk: PoolWasteRisk;
  /** Absolute balance for credits rows; not a percentage. */
  creditsRemaining: number | null;
  held: boolean | null;
  /** Jobs running on the lane against its slot target, as the dispatcher last reported them. */
  running: number | null;
  target: number | null;
  /** The reader that produced the usage reading; null when the ledger does not name one. */
  source: string | null;
  /** Per-model windows beside the pool's own. Empty unless the pool's reading is current. */
  scopes: PoolScope[];
  /** When the reading was captured. A dispatcher tick never substitutes for it. */
  asOf: string | null;
  /** Why the row is unknown; null when the risk is known. */
  reason: string | null;
  /** Plain words: "on pace", "behind: 30% would go unused", "unknown: ...". */
  summary: string;
}
export interface PoolsViewV1 {
  schema: typeof POOLS_SCHEMA;
  generatedAt: string;
  staleAfterMinutes: number;
  /** Most at risk first, then soonest reset, then id. */
  pools: PoolRow[];
  /** What this view cannot see, so a short list is not read as full coverage. */
  gaps: string[];
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const clampPct = (value: number): number => Math.min(100, Math.max(0, value));

/** One threshold for every surface: half the window unused is high, 15% is medium. */
export function wasteLevel(unusedPct: number): Exclude<PoolWasteRisk, 'unknown'> {
  return unusedPct >= 50 ? 'high' : unusedPct >= 15 ? 'medium' : 'low';
}

function poolRow(lane: ResourceLaneRow, now: number): PoolRow {
  const evidence = lane.quotaEvidence;
  const asOf = evidence?.measuredQuota?.observedAt ?? lane.observation?.asOf ?? evidence?.statusQuota?.observedAt ?? null;
  const row: PoolRow = {
    id: lane.lane, kind: lane.window === 'weekly' ? 'subscription' : lane.window === 'credits' ? 'credits' : 'unmetered',
    usedPct: null, resetAt: lane.resetAt, hoursLeft: null, elapsedPct: null, burnPctPerHour: null, burnBasis: null,
    projectedUnusedPct: null, wasteRisk: 'unknown', creditsRemaining: lane.creditsRemaining, held: lane.held,
    running: lane.running, target: lane.target, source: lane.observation?.source ?? lane.source, scopes: [], asOf,
    reason: null, summary: '',
  };
  const unknown = (reason: string): PoolRow => ({ ...row, reason, summary: `unknown: ${reason}` });
  if (row.kind === 'unmetered') return unknown('no usage window reported');
  if (row.kind === 'credits') return unknown('credit balance has no total or expiry, so percent used is not known');
  if (lane.usedPct === null) return unknown('no reading');
  const resetMs = lane.resetAt === null ? NaN : Date.parse(lane.resetAt);
  if (Number.isFinite(resetMs) && resetMs <= now) return unknown(`window reset at ${lane.resetAt}; no reading for the new window`);
  const asOfMs = asOf === null ? NaN : Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return unknown('reading has no capture time');
  if (asOfMs > now) return unknown(`reading is dated in the future (${asOf})`);
  if (now - asOfMs > POOLS_STALE_AFTER_MINUTES * 60_000) return unknown(`no reading since ${asOf}`);

  const usedPct = clampPct(lane.usedPct);
  row.usedPct = round1(usedPct);
  // Per-model windows ride on the same current reading; one whose own reset has passed is unknown, like the pool's.
  row.scopes = (lane.quotaScopes ?? []).map(scope => {
    const scopeReset = scope.resetAt === null ? NaN : Date.parse(scope.resetAt);
    const open = !(scopeReset <= now);
    return { id: scope.id, usedPct: open ? round1(clampPct(scope.usedPct)) : null, resetAt: scope.resetAt,
      hoursLeft: open && Number.isFinite(scopeReset) ? round1((scopeReset - now) / HOUR_MS) : null };
  });
  if (!Number.isFinite(resetMs)) return unknown('reset time not reported');
  const hoursLeft = (resetMs - now) / HOUR_MS;
  const elapsedHours = Math.max(0, WEEK_HOURS - hoursLeft);
  const observationHoursLeft = (resetMs - asOfMs) / HOUR_MS;
  const observedElapsedHours = Math.max(0, WEEK_HOURS - observationHoursLeft);
  row.hoursLeft = round1(hoursLeft);
  row.elapsedPct = round1(clampPct(elapsedHours / WEEK_HOURS * 100));
  // A held lane spends nothing, so everything left is at risk.
  const burn = lane.held === true ? 0 : lane.burnPctPerHour ?? (observedElapsedHours > 0 ? usedPct / observedElapsedHours : null);
  if (burn === null) return unknown('burn rate not known yet');
  row.burnPctPerHour = Math.round(burn * 100) / 100;
  row.burnBasis = lane.held === true ? 'held' : lane.burnPctPerHour !== null ? 'reported' : 'window-average';
  const projectionHours = lane.burnPctPerHour === null ? observationHoursLeft : hoursLeft;
  const unusedPct = clampPct(100 - usedPct - burn * projectionHours);
  row.projectedUnusedPct = round1(unusedPct);
  row.wasteRisk = wasteLevel(unusedPct);
  row.summary = usedPct >= 100 ? 'fully used'
    : row.wasteRisk === 'low' ? 'on pace'
      : `behind: ${Math.round(row.projectedUnusedPct)}% would go unused${lane.held === true ? ' (lane is held)' : ''}`;
  return row;
}

const RISK_RANK: Record<PoolWasteRisk, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
const resetOrder = (row: PoolRow): number => {
  const ms = row.resetAt === null ? NaN : Date.parse(row.resetAt);
  return Number.isFinite(ms) ? ms : Infinity;
};

export function buildPoolsView(ledger: ResourceLedgerV1, now: number): PoolsViewV1 {
  const pools = ledger.lanes.map(lane => poolRow(lane, now)).sort((a, b) =>
    RISK_RANK[a.wasteRisk] - RISK_RANK[b.wasteRisk]
    || (resetOrder(a) === resetOrder(b) ? 0 : resetOrder(a) < resetOrder(b) ? -1 : 1)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const gaps = ['API credit grants and cloud credits with an expiry are not in the resource ledger yet; credits rows show a balance only.'];
  if (ledger.sources.status !== 'healthy') gaps.unshift(`dispatcher status is ${ledger.sources.status}; lanes it would report may be absent.`);
  return { schema: POOLS_SCHEMA, generatedAt: new Date(now).toISOString(), staleAfterMinutes: POOLS_STALE_AFTER_MINUTES, pools, gaps };
}

const cell = (value: number | null, unit: string): string => value === null ? 'unknown' : `${value}${unit}`;

/** `phm pools --text`: one line per resource, same order as the JSON. */
export function formatPoolsText(view: PoolsViewV1): string {
  const lines = [`Pools as of ${view.generatedAt} (most at risk of waste first)`];
  if (!view.pools.length) lines.push('No resources reported.');
  for (const row of view.pools) {
    lines.push(`${row.id}: ${row.summary}`);
    lines.push(`  risk ${row.wasteRisk}; used ${cell(row.usedPct, '%')}; resets ${row.resetAt ?? 'unknown'} (${cell(row.hoursLeft, 'h')} left); `
      + `burn ${cell(row.burnPctPerHour, '%/h')}${row.burnBasis ? ` (${row.burnBasis})` : ''}; unused at reset ${cell(row.projectedUnusedPct, '%')}; as of ${row.asOf ?? 'unknown'}`);
    for (const scope of row.scopes) lines.push(`  ${scope.id}: used ${cell(scope.usedPct, '%')}; resets ${scope.resetAt ?? 'unknown'} (${cell(scope.hoursLeft, 'h')} left)`);
  }
  for (const gap of view.gaps) lines.push(`Not covered: ${gap}`);
  return lines.join('\n');
}
