import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PACE_POOLS } from './pace.js';

export interface SpendRow {
  pool: string; reason: string | null; usedPercent: number | null; resetAt: string | null;
  hoursLeft: number | null; burnPerHour: number | null; projectedUnusedPercent: number | null;
}
export interface SpendSnapshot { v: 1; asOf: string | null; pools: SpendRow[] }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Only the measured use-it-all reading has an explicit freshness signal. */
export function projectUsageSpend(raw: unknown, now = Date.now()): SpendSnapshot {
  const status = object(raw) ? raw : {};
  const tick = typeof status.last_tick === 'string' ? Date.parse(status.last_tick) : NaN;
  const fresh = status.schema === 'dispatchd.status.v1' && Number.isFinite(tick) && now >= tick && now - tick <= 120_000;
  const budget = object(status.budget) ? status.budget : {};
  const names = [...new Set([...PACE_POOLS, ...Object.keys(budget).filter(k => /^[a-z0-9][a-z0-9-]{0,63}$/.test(k))])].sort();
  return { v: 1, asOf: Number.isFinite(tick) ? new Date(tick).toISOString() : null, pools: names.map(pool => {
    const lane = object(budget[pool]) ? budget[pool] : {};
    const pace = object(lane.use_it_all) ? lane.use_it_all : {};
    const reset = typeof pace.reset_at === 'string' ? Date.parse(pace.reset_at) : num(pace.reset_at) ? pace.reset_at * 1000 : NaN;
    const reason = !fresh ? 'status missing or stale' : pace.stale === true ? 'reading stale' : pace.known !== true || pace.stale !== false ? 'reading missing' :
      !num(pace.used_pct) || pace.used_pct < 0 || pace.used_pct > 100 || !Number.isFinite(reset) || reset <= now ||
      !num(pace.burn_pct_per_hour) || pace.burn_pct_per_hour < 0 ? 'reading incomplete or reset passed' : null;
    const hours = reason === null ? (reset - now) / 3_600_000 : null;
    const used = reason === null ? pace.used_pct as number : null;
    const burn = reason === null ? pace.burn_pct_per_hour as number : null;
    return { pool, reason, usedPercent: used, resetAt: reason === null ? new Date(reset).toISOString() : null,
      hoursLeft: hours, burnPerHour: burn, projectedUnusedPercent: hours !== null && used !== null && burn !== null ? Math.max(0, 100 - used - burn * hours) : null };
  }) };
}
export async function readUsageSpend(path = join(homedir(), '.ashlr-runs', 'queue', 'status.json')): Promise<SpendSnapshot> {
  try { const text = await readFile(path, 'utf8'); return projectUsageSpend(text.length <= 1024 * 1024 ? JSON.parse(text) as unknown : null); }
  catch { return projectUsageSpend(null); }
}
