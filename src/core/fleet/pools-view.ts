/**
 * `pools.v1`: the zero-waste read of the resource ledger. One row per resource
 * with how much is used, when it resets, and how much would go unused at the
 * current burn. Behind `phm pools`, GET /api/app/pools and the Pools pane.
 *
 * Pure and browser-safe (type-only imports): it derives from ResourceLedgerV1
 * and keeps no state of its own. A stale or missing reading is unknown with a
 * reason, never zero.
 */
import { burnRate, BURN_METHOD, BURN_MIN_SAMPLES, BURN_WINDOW_HOURS, type BurnSample } from '../usage/burn-rate.js';
import { poolLabel } from '../usage/runway.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from './runs-resource-ledger.js';

export const POOLS_SCHEMA = 'pools.v1';
export const POOLS_PATH = '/api/app/pools';
/** A usage reading older than this no longer describes the pool. */
export const POOLS_STALE_AFTER_MINUTES = 60;
/** Ledger lanes with a `weekly` window reset every seven days. */
const WEEK_HOURS = 168;
const HOUR_MS = 3_600_000;
/** A pool that would be empty this many hours before its reset is spending too fast. */
export const POOLS_EMPTY_EARLY_HOURS = 6;

/** One stored usage reading of a pool (the rows of metrics/usage-history.json). */
export interface PoolSample { pool: string; used_pct: number; observed_at: string; reset_at: string | null }
/** What the planner should do about the pool, in one word. */
export type PoolVerdict = 'slow down' | 'add work' | 'on pace' | 'fully used' | 'not enough readings' | 'unknown';
/** The evidence behind the burn number. */
export interface PoolBurn {
  samples: number;
  /** Hours between the oldest and newest reading used. */
  window_h: number;
  method: typeof BURN_METHOD | 'reported' | 'held' | 'none';
}

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
  /** `least-squares` is the slope of the last 6 h of real readings; `reported` is the dispatcher's own figure. */
  burnBasis: 'least-squares' | 'reported' | 'held' | null;
  /** How the burn was measured: reading count, span and method. */
  burn: PoolBurn;
  projectedUnusedPct: number | null;
  /** When the pool runs empty at this burn; null when it lasts past the reset or the burn is unknown. */
  projectedEmptyAt: string | null;
  verdict: PoolVerdict;
  wasteRisk: PoolWasteRisk;
  /** Absolute balance for credits rows; not a percentage. */
  creditsRemaining: number | null;
  /** `usd` when `creditsRemaining` is a US-dollar gift credit; absent when the unit is not reported. */
  creditUnit?: 'usd';
  /** Gift credit: when the balance was last read, whether its lane is closed, and whole days until it expires. */
  creditAsOf?: string | null;
  creditClosed?: boolean;
  daysLeft?: number | null;
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
  /** The verdict in plain words: "Claude: empty about 3 PM Thu, 27 h before reset: slow down". */
  summary: string;
}
export interface PoolsViewV1 {
  schema: typeof POOLS_SCHEMA;
  generatedAt: string;
  staleAfterMinutes: number;
  /** Running out early first, then most at risk of waste, then soonest reset, then id. */
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

/** "3 PM Thu": the weekday and hour a pool runs empty, in the reader's own time zone. */
function clockWords(ms: number): string {
  const at = new Date(ms);
  return `${at.toLocaleString('en-US', { hour: 'numeric' })} ${at.toLocaleString('en-US', { weekday: 'short' })}`.replace(/\s/g, ' ');
}
const hoursWords = (hours: number): string => `${Math.max(1, Math.round(hours))} h`;

/** "Nov 24": month and day in UTC, so the same date reads the same on every surface. */
export const monthDay = (iso: string): string => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A dollar gift has a balance, not a percent: name the balance, its reading date, the days left and a closed lane. */
function giftRow(row: PoolRow, name: string, now: number): PoolRow {
  const endMs = row.resetAt === null ? NaN : Date.parse(row.resetAt);
  const daysLeft = Number.isFinite(endMs) ? Math.max(0, Math.floor((endMs - now) / 86_400_000)) : null;
  const expired = Number.isFinite(endMs) && endMs <= now;
  const balance = row.creditsRemaining === null ? 'balance unknown'
    : `${row.creditAsOf ? `last reading ${monthDay(row.creditAsOf)}: ` : ''}about ${Math.round(row.creditsRemaining)} USD`;
  const ends = expired ? 'expired' : daysLeft === null ? 'expiry unknown' : `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${monthDay(row.resetAt!)})`;
  const reason = 'a dollar credit has a balance, not a percent used';
  return { ...row, daysLeft, reason, summary: `${name}: ${balance}; ${ends}${row.creditClosed ? '; lane closed' : ''}` };
}

function poolRow(lane: ResourceLaneRow, now: number, samples: readonly PoolSample[]): PoolRow {
  const evidence = lane.quotaEvidence;
  const asOf = evidence?.measuredQuota?.observedAt ?? lane.observation?.asOf ?? evidence?.statusQuota?.observedAt ?? null;
  const name = poolLabel(lane.lane);
  const row: PoolRow = {
    id: lane.lane, kind: lane.window === 'weekly' ? 'subscription' : lane.window === 'credits' ? 'credits' : 'unmetered',
    usedPct: null, resetAt: lane.resetAt, hoursLeft: null, elapsedPct: null, burnPctPerHour: null, burnBasis: null,
    burn: { samples: 0, window_h: 0, method: 'none' }, projectedUnusedPct: null, projectedEmptyAt: null, verdict: 'unknown',
    wasteRisk: 'unknown', creditsRemaining: lane.creditsRemaining, ...(lane.creditUnit ? { creditUnit: lane.creditUnit, creditAsOf: lane.creditAsOf ?? null, creditClosed: lane.creditClosed === true } : {}), held: lane.held,
    running: lane.running, target: lane.target, source: lane.observation?.source ?? lane.source, scopes: [], asOf,
    reason: null, summary: '',
  };
  const unknown = (reason: string): PoolRow => ({ ...row, reason, summary: `${name}: unknown: ${reason}` });
  if (row.kind === 'unmetered') return unknown('no usage window reported');
  if (row.kind === 'credits' && row.creditUnit === 'usd') return giftRow(row, name, now);
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
  row.hoursLeft = round1(hoursLeft);
  row.elapsedPct = round1(clampPct(elapsedHours / WEEK_HOURS * 100));

  // Burn: a held lane spends nothing; otherwise the slope of the pool's own recent readings (the current reading is the
  // newest point); otherwise the dispatcher's reported figure. Never the window average: it hides a recent climb.
  const own: BurnSample[] = samples.filter(sample => sample.pool === lane.lane)
    .map(sample => ({ at: sample.observed_at, used_pct: sample.used_pct, reset_at: sample.reset_at }));
  if (!own.some(sample => Date.parse(sample.at) >= asOfMs)) own.push({ at: new Date(asOfMs).toISOString(), used_pct: usedPct, reset_at: lane.resetAt });
  const fitted = burnRate(own, now);
  let burn: number | null;
  if (lane.held === true) {
    burn = 0; row.burnBasis = 'held'; row.burn = { samples: fitted.samples, window_h: fitted.window_h, method: 'held' };
  } else if (fitted.points_per_hour !== null) {
    burn = fitted.points_per_hour; row.burnBasis = 'least-squares';
    row.burn = { samples: fitted.samples, window_h: fitted.window_h, method: fitted.method };
  } else if (lane.burnPctPerHour !== null) {
    burn = lane.burnPctPerHour; row.burnBasis = 'reported';
    row.burn = { samples: fitted.samples, window_h: fitted.window_h, method: 'reported' };
  } else {
    row.burn = { samples: fitted.samples, window_h: fitted.window_h, method: BURN_METHOD };
    row.reason = fitted.reason;
    row.verdict = 'not enough readings';
    row.summary = `${name}: not enough readings (${fitted.samples} of ${BURN_MIN_SAMPLES} in the last ${BURN_WINDOW_HOURS} h)`;
    return row;
  }
  row.burnPctPerHour = Math.round(burn * 100) / 100;
  const left = 100 - usedPct;
  const unusedPct = clampPct(left - burn * hoursLeft);
  row.projectedUnusedPct = round1(unusedPct);
  row.wasteRisk = wasteLevel(unusedPct);
  const emptyHours = burn > 0 ? left / burn : null;
  const earlyHours = emptyHours === null ? 0 : hoursLeft - emptyHours;
  if (emptyHours !== null && earlyHours > 0) row.projectedEmptyAt = new Date(now + emptyHours * HOUR_MS).toISOString();
  const held = lane.held === true ? ' (lane is held)' : '';
  if (usedPct >= 100) { row.verdict = 'fully used'; row.summary = `${name}: fully used`; }
  else if (earlyHours >= POOLS_EMPTY_EARLY_HOURS) {
    row.verdict = 'slow down';
    row.summary = `${name}: empty about ${clockWords(now + emptyHours! * HOUR_MS)}, ${hoursWords(earlyHours)} before reset: slow down`;
  } else if (row.wasteRisk !== 'low') {
    row.verdict = 'add work';
    row.summary = `${name}: ${Math.round(unusedPct)}% will go unused: add work${held}`;
  } else { row.verdict = 'on pace'; row.summary = `${name}: on pace`; }
  return row;
}

const RISK_RANK: Record<PoolWasteRisk, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
const resetOrder = (row: PoolRow): number => {
  const ms = row.resetAt === null ? NaN : Date.parse(row.resetAt);
  return Number.isFinite(ms) ? ms : Infinity;
};

/**
 * `samples` are the stored usage readings (`readUsageSamples`); without them a pool falls back to the dispatcher's
 * reported burn, or says "not enough readings".
 */
export function buildPoolsView(ledger: ResourceLedgerV1, now: number, samples: readonly PoolSample[] = []): PoolsViewV1 {
  const pools = ledger.lanes.map(lane => poolRow(lane, now, samples)).sort((a, b) =>
    (a.verdict === 'slow down' ? -1 : RISK_RANK[a.wasteRisk]) - (b.verdict === 'slow down' ? -1 : RISK_RANK[b.wasteRisk])
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
    lines.push(row.summary);
    lines.push(`  risk ${row.wasteRisk}; used ${cell(row.usedPct, '%')}; resets ${row.resetAt ?? 'unknown'} (${cell(row.hoursLeft, 'h')} left); `
      + `burn ${cell(row.burnPctPerHour, '%/h')}${row.burnBasis ? ` (${row.burnBasis === 'least-squares' ? `${row.burnBasis}, ${row.burn.samples} readings over ${row.burn.window_h} h` : row.burnBasis})` : ''}; unused at reset ${cell(row.projectedUnusedPct, '%')}; empty ${row.projectedEmptyAt ?? (row.burnPctPerHour === null ? 'unknown' : 'not before reset')}; as of ${row.asOf ?? 'unknown'}`);
    for (const scope of row.scopes) lines.push(`  ${scope.id}: used ${cell(scope.usedPct, '%')}; resets ${scope.resetAt ?? 'unknown'} (${cell(scope.hoursLeft, 'h')} left)`);
  }
  for (const gap of view.gaps) lines.push(`Not covered: ${gap}`);
  return lines.join('\n');
}
