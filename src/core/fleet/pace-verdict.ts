/**
 * Pace of one usage pool against its reset: is it spending so fast it will be empty
 * more than a day early ("ahead"), so slowly that room is left over ("behind"), or about right.
 *
 * `paceVerdict` is pure (no clock, no files). The router, autofill and `phm jobs gaps --propose`
 * use it to stop adding rows to a pool that would go dark early and to prefer one with room.
 * Nothing here changes a plan or a bill: it only chooses among pools already included.
 */
import { poolLabel } from '../usage/runway.js';
import type { PoolRow } from './pools-view.js';

export const PACE_SCHEMA = 'fleet.pace.v1';
/** A pool empty this many hours before its reset is "ahead". */
export const AHEAD_EMPTY_EARLY_HOURS = 24;
/** A pool that would end its window with at least this share unused is "behind". */
export const BEHIND_UNUSED_PCT = 15;

export type PaceState = 'on-pace' | 'ahead' | 'behind' | 'unknown';

export type PaceInput = Pick<PoolRow, 'id' | 'usedPct' | 'hoursLeft' | 'burnPctPerHour' | 'resetAt'>;

export interface PaceVerdict {
  pool: string;
  state: PaceState;
  usedPct: number | null;
  hoursToReset: number | null;
  /** When the pool is empty at the recent rate; null when it lasts past the reset or the rate is unknown. */
  emptyAt: string | null;
  /** Percent of the window per hour that would use exactly what is left by the reset. */
  evenPacePerHour: number | null;
  /** Percent of the window per hour over the recent readings. */
  recentPerHour: number | null;
  resetAt: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function paceVerdict(pool: PaceInput, nowMs: number): PaceVerdict {
  const { usedPct, hoursLeft: hours, burnPctPerHour: recent } = pool;
  const base = { pool: pool.id, usedPct, hoursToReset: hours, resetAt: pool.resetAt };
  if (usedPct === null || hours === null || hours <= 0 || recent === null || !Number.isFinite(recent)) {
    return { ...base, state: 'unknown', emptyAt: null, evenPacePerHour: null, recentPerHour: recent ?? null };
  }
  const left = Math.max(0, 100 - usedPct);
  const even = round2(left / hours);
  const emptyHours = recent > 0 ? left / recent : Infinity;
  const emptyAt = emptyHours < hours ? new Date(nowMs + emptyHours * 3_600_000).toISOString() : null;
  const state: PaceState = left > 0 && emptyHours < hours - AHEAD_EMPTY_EARLY_HOURS ? 'ahead'
    : left > 0 && left - recent * hours >= BEHIND_UNUSED_PCT ? 'behind' : 'on-pace';
  return { ...base, state, emptyAt, evenPacePerHour: even, recentPerHour: round2(recent) };
}

/** "Sat 4 PM" in the reader's zone. */
const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' }).replace(',', '');

/** "claude ahead of pace (empty Sat 4 PM, reset Thu 6 PM)". Only for an ahead pool. */
export function aheadWords(v: PaceVerdict): string {
  const empty = v.emptyAt ? `empty ${when(v.emptyAt)}` : 'empty early';
  return `${v.pool} ahead of pace (${empty}${v.resetAt ? `, reset ${when(v.resetAt)}` : ''})`;
}

/** One plain line per pool for `phm fleet pace`. */
export function paceLine(v: PaceVerdict): string {
  const label = poolLabel(v.pool);
  if (v.state === 'unknown') return `${label}: unknown (no usable reading)`;
  const rates = `${v.usedPct}% used, ${v.recentPerHour}%/h recent vs ${v.evenPacePerHour}%/h even`;
  const head = v.state === 'ahead' ? aheadWords(v).replace(v.pool, label)
    : v.state === 'behind' ? `${label} behind pace (would end with room left)` : `${label} on pace`;
  return `${head}: ${rates}`;
}

export interface FleetPaceV1 { schema: typeof PACE_SCHEMA; generatedAt: string; pools: PaceVerdict[]; gaps: string[] }

/** Verdicts for every pool in a pools view. Pure. */
export function buildFleetPace(view: { generatedAt: string; pools: readonly PaceInput[] }, nowMs: number): FleetPaceV1 {
  return {
    schema: PACE_SCHEMA, generatedAt: view.generatedAt,
    pools: view.pools.map(p => paceVerdict(p, nowMs)).sort((a, b) => a.pool.localeCompare(b.pool)),
    gaps: ['Pool names are matched to lanes of the same name; a lane with no pool row is unknown.'],
  };
}

/** Reads the resource ledger and usage history, then the verdicts. Read-only. */
export async function readFleetPace(opts: { runsDir?: string; now?: () => number } = {}): Promise<FleetPaceV1> {
  const nowMs = (opts.now ?? Date.now)();
  const [{ readResourceLedger }, { buildPoolsView }, { readUsageSamples }] = await Promise.all([
    import('./runs-resource-ledger.js'), import('./pools-view.js'), import('./usage-history.js'),
  ]);
  const runs = opts.runsDir === undefined ? {} : { runsDir: opts.runsDir };
  const view = buildPoolsView(await readResourceLedger({ ...runs, now: () => nowMs }), nowMs, await readUsageSamples({ nowMs }));
  return buildFleetPace(view, nowMs);
}

/** Verdicts keyed by pool/lane name, or an empty map when the read fails (unknown changes nothing). */
export async function readPaceByPool(opts: { runsDir?: string; now?: () => number } = {}): Promise<Map<string, PaceVerdict>> {
  try { return new Map((await readFleetPace(opts)).pools.map(p => [p.pool, p])); } catch { return new Map(); }
}
