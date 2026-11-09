import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PACE_POOLS = ['zai', 'gemini', 'claude', 'codex-personal'] as const;
export interface PaceRow { pool: string; projectedPercent: number | null; hoursLeft: number | null }
export interface PaceSnapshot { v: 1; asOf: string | null; pools: PaceRow[] }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A controller tick may republish a stale reading; both freshness checks are required. */
export function projectUsagePace(raw: unknown, now = Date.now()): PaceSnapshot {
  const status = object(raw) ? raw : {};
  const tick = typeof status.last_tick === 'string' ? Date.parse(status.last_tick) : NaN;
  const fresh = status.schema === 'dispatchd.status.v1' && Number.isFinite(tick) && now >= tick && now - tick <= 120_000;
  const budget = object(status.budget) ? status.budget : {};
  return { v: 1, asOf: Number.isFinite(tick) ? new Date(tick).toISOString() : null, pools: PACE_POOLS.map(pool => {
    const lane = object(budget[pool]) ? budget[pool] : {};
    const pace = object(lane.use_it_all) ? lane.use_it_all : {};
    const valid = fresh && pace.known === true && pace.stale === false && number(pace.projected_used_pct)
      && pace.projected_used_pct >= 0 && pace.projected_used_pct <= 100 && number(pace.hours_to_reset) && pace.hours_to_reset > 0;
    return { pool, projectedPercent: valid ? pace.projected_used_pct as number : null, hoursLeft: valid ? pace.hours_to_reset as number : null };
  }) };
}

export async function readUsagePace(path = join(homedir(), '.ashlr-runs', 'queue', 'status.json')): Promise<PaceSnapshot> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > 1024 * 1024) return projectUsagePace(null);
    return projectUsagePace(JSON.parse(text) as unknown);
  } catch { return projectUsagePace(null); }
}
