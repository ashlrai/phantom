/**
 * `phm pool runway` and GET /api/usage/runway: one runway row per pool from the
 * dispatchd status ledger `phm spend` already reads (`budget.<lane>.use_it_all`).
 * Unknown stays unknown.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PACE_POOLS, projectUsagePace } from './pace.js';
import { readDispatchStatus } from './spend.js';
import { POOL_RUNWAY_SCHEMA, runway, runwayHeadline, sortRunways, type RunwaySnapshot } from './runway.js';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const POOL_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MAX_POOLS = 24;
const FRESH_MS = 120_000;

/** One row per percent-window pool in `budget.<lane>.use_it_all`; the core pools always show, unknown when absent. */
export function projectPoolRunway(raw: unknown, now = Date.now()): RunwaySnapshot {
  const status = object(raw) ? raw : {};
  const tick = typeof status.last_tick === 'string' ? Date.parse(status.last_tick) : NaN;
  const fresh = status.schema === 'dispatchd.status.v1' && Number.isFinite(tick) && now >= tick && now - tick <= FRESH_MS;
  const budget = fresh && object(status.budget) ? status.budget : {};
  const extra = Object.keys(budget).filter(name => !(PACE_POOLS as readonly string[]).includes(name) && POOL_NAME.test(name)
    && object(budget[name]) && object((budget[name] as Record<string, unknown>).use_it_all)).sort();
  const names = [...PACE_POOLS, ...extra].slice(0, MAX_POOLS);
  const pools = names.map(pool => {
    if (!fresh) return { ...runway({ pool, usedPercent: null, burnPerHour: null, hoursToReset: null }), reason: 'status missing or stale', advice: 'unknown: status missing or stale' };
    const lane = object(budget[pool]) ? budget[pool] : {};
    const pace = object(lane.use_it_all) ? lane.use_it_all : {};
    if (pace.known !== true || pace.stale !== false) {
      const why = pace.stale === true ? 'reading stale' : 'reading missing';
      return { ...runway({ pool, usedPercent: null, burnPerHour: null, hoursToReset: null }), reason: why, advice: `unknown: ${why}` };
    }
    const resetMs = typeof pace.reset_at === 'string' ? Date.parse(pace.reset_at) : num(pace.reset_at) ? pace.reset_at * 1000 : NaN;
    const hoursToReset = Number.isFinite(resetMs) ? (resetMs - now) / 3_600_000 : num(pace.hours_to_reset) ? pace.hours_to_reset : null;
    // Overage readings above 1000% are malformed, as in spend.ts.
    const usedPercent = num(pace.used_pct) && pace.used_pct <= 1000 ? pace.used_pct : null;
    return runway({ pool, usedPercent, burnPerHour: num(pace.burn_pct_per_hour) ? pace.burn_pct_per_hour : null, hoursToReset });
  });
  const sorted = sortRunways(pools);
  return { schema: POOL_RUNWAY_SCHEMA, v: 1, asOf: Number.isFinite(tick) ? new Date(tick).toISOString() : null, headline: runwayHeadline(sorted), pools: sorted, shares: projectUsagePace(raw, now).shares };
}

export const runwayStatusPath = (runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')): string =>
  join(runsDir, 'queue', 'status.json');

export async function readPoolRunway(path = runwayStatusPath(), now = Date.now()): Promise<RunwaySnapshot> {
  return projectPoolRunway(await readDispatchStatus(path), now);
}
