import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PACE_POOLS = ['zai', 'gemini', 'claude', 'codex-personal'] as const;
export interface PaceRow { pool: string; projectedPercent: number | null; hoursLeft: number | null; recommendedSlots: number | null;
  /** 100 - projectedPercent, integer; null whenever the projection is unknown. */
  unusedPercent: number | null }
const POOL_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MAX_POOLS = 24;

/** The fixed core pools first, then every other budgeted lane with a use_it_all object, by name. */
function paceLaneNames(budget: Record<string, unknown>): string[] {
  const core: readonly string[] = PACE_POOLS;
  const extra = Object.keys(budget).filter(name => !core.includes(name) && POOL_NAME.test(name)
    && object(budget[name]) && object((budget[name] as Record<string, unknown>).use_it_all)).sort();
  return [...core, ...extra].slice(0, MAX_POOLS);
}

export interface PaceSnapshot { v: 1; asOf: string | null; pools: PaceRow[] }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface PaceTargetInput {
  usedPercent: number; hoursLeft: number; burnPerHour: number; running: number;
  hardCap: number; load1: number; ncpu: number; loadMax: number;
}

/** Estimate per-slot burn from the current aggregate rate. Load headroom is advisory,
 * assuming one load unit per additional slot; it cannot authorize dispatch. */
export function paceTarget(lane: PaceTargetInput): number | null {
  const { usedPercent, hoursLeft, burnPerHour, running, hardCap, load1, ncpu, loadMax } = lane;
  if (![usedPercent, hoursLeft, burnPerHour, running, hardCap, load1, ncpu, loadMax].every(number)
    || usedPercent < 0 || usedPercent > 100 || hoursLeft <= 0 || burnPerHour <= 0
    || !Number.isInteger(running) || running <= 0 || !Number.isInteger(hardCap) || hardCap < 0
    || load1 < 0 || !Number.isInteger(ncpu) || ncpu <= 0 || loadMax <= 0) return null;
  const needed = (100 - usedPercent) / hoursLeft / burnPerHour * running;
  return Math.min(hardCap, running + Math.floor(Math.max(0, loadMax - load1)), Math.max(0, Math.round(needed)));
}

/** A controller tick may republish a stale reading; both freshness checks are required. */
export function projectUsagePace(raw: unknown, now = Date.now()): PaceSnapshot {
  const status = object(raw) ? raw : {};
  const tick = typeof status.last_tick === 'string' ? Date.parse(status.last_tick) : NaN;
  const fresh = status.schema === 'dispatchd.status.v1' && Number.isFinite(tick) && now >= tick && now - tick <= 120_000;
  const budget = object(status.budget) ? status.budget : {};
  const lanes = object(status.lanes) ? status.lanes : {};
  const admission = object(status.admission) ? status.admission : {};
  return { v: 1, asOf: Number.isFinite(tick) ? new Date(tick).toISOString() : null, pools: (fresh ? paceLaneNames(budget) : [...PACE_POOLS]).map(pool => {
    const lane = object(budget[pool]) ? budget[pool] : {};
    const pace = object(lane.use_it_all) ? lane.use_it_all : {};
    const valid = fresh && pace.known === true && pace.stale === false && number(pace.projected_used_pct)
      && pace.projected_used_pct >= 0 && pace.projected_used_pct <= 100 && number(pace.hours_to_reset) && pace.hours_to_reset > 0;
    const slots = object(lanes[pool]) ? lanes[pool] : {};
    const recommendedSlots = fresh && pace.known === true && pace.stale === false
      ? paceTarget({ usedPercent: pace.used_pct as number, hoursLeft: pace.hours_to_reset as number,
        burnPerHour: pace.burn_pct_per_hour as number, running: slots.running as number, hardCap: slots.hard_cap as number,
        load1: admission.load1 as number, ncpu: admission.ncpu as number, loadMax: admission.load_max as number }) : null;
    const projectedPercent = valid ? pace.projected_used_pct as number : null;
    return { pool, projectedPercent, hoursLeft: valid ? pace.hours_to_reset as number : null, recommendedSlots,
      unusedPercent: projectedPercent === null ? null : Math.round(100 - projectedPercent) };
  }) };
}

export async function readUsagePace(path = join(homedir(), '.ashlr-runs', 'queue', 'status.json')): Promise<PaceSnapshot> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > 1024 * 1024) return projectUsagePace(null);
    return projectUsagePace(JSON.parse(text) as unknown);
  } catch { return projectUsagePace(null); }
}
