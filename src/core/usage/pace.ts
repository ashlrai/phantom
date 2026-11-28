import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isFiniteNumber as number,
  isPlainObject as object,
  parseDispatchStatusEnvelope,
  parseEpochSecondsOrIsoMs,
  poolShareSnapshot,
  type PoolShareInput,
  type PoolShareSnapshot,
} from './runway.js';

export const PACE_POOLS = ['zai', 'gemini', 'claude', 'codex-personal'] as const;
export interface PaceRow { pool: string; projectedPercent: number | null; hoursLeft: number | null; recommendedSlots: number | null;
  /** 100 - projectedPercent, integer; null whenever the projection is unknown. */
  unusedPercent: number | null }
const POOL_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MAX_POOLS = 24;

/** The fixed core pools first, then every other budgeted lane with a use_it_all object, by name. */
function paceLaneNames(budget: Record<string, unknown>): string[] {
  const core: readonly string[] = PACE_POOLS;
  const extra = Object.keys(budget).filter(name => name !== 'codex-cmp' && !core.includes(name) && POOL_NAME.test(name)
    && object(budget[name]) && object((budget[name] as Record<string, unknown>).use_it_all)).sort();
  return [...core, ...extra].slice(0, MAX_POOLS);
}

export interface PaceSnapshot { v: 1; asOf: string | null; pools: PaceRow[];
  /** Per-pool runway verdict and suggested share of new work (`phm fleet pools --json`), from the same readings. */
  shares: PoolShareSnapshot }

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

/** Readings for planPoolShares; anything not fresh, known and current stays null (unknown). */
function shareInput(pool: string, lane: unknown, now: number, fresh: boolean): PoolShareInput {
  const empty = { pool, usedPercent: null, burnPerHour: null, hoursToReset: null, unit: (pool === 'claude-api' || object(lane) && object(lane.gift) ? 'usd' : 'percent') as 'usd' | 'percent' };
  if (!fresh) return { ...empty, reason: 'status missing or stale' };
  if (object(lane) && object(lane.gift)) {
    const gift = lane.gift;
    const at = typeof gift.as_of === 'string' ? Date.parse(gift.as_of) : NaN;
    const reset = typeof gift.expires_at === 'string' ? Date.parse(gift.expires_at) : NaN;
    const remaining = number(gift.usd_remaining) && gift.usd_remaining >= 0 ? gift.usd_remaining : null;
    const grant = number(gift.usd_granted) && gift.usd_granted > 0 && remaining !== null && gift.usd_granted >= remaining ? gift.usd_granted : null;
    const base = { ...empty, unit: 'usd' as const };
    if (!Number.isFinite(at) || at > now + 60_000) return { ...base, reason: 'no reading' };
    if (now - at > 86_400_000) return { ...base, reason: 'reading stale' };
    if (remaining === null || grant === null) return { ...base, remainingUsd: remaining, reason: 'gift allowance missing' };
    return { ...base, remainingUsd: remaining, usedPercent: (grant - remaining) / grant * 100,
      burnPerHour: number(gift.usd_burn_per_hour) ? gift.usd_burn_per_hour / grant * 100 : null,
      hoursToReset: Number.isFinite(reset) ? (reset - now) / 3_600_000 : null,
      resetAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null };
  }
  const pace = object(lane) && object(lane.use_it_all) ? lane.use_it_all : {};
  if (pace.known !== true || pace.stale !== false) return { ...empty, unit: pool === 'claude-api' ? 'usd' : 'percent', reason: pace.stale === true ? 'reading stale' : 'no reading' };
  const resetMs = parseEpochSecondsOrIsoMs(pace.reset_at);
  const hours = Number.isFinite(resetMs) ? (resetMs - now) / 3_600_000 : number(pace.hours_to_reset) && Math.abs(now + pace.hours_to_reset * 3_600_000) <= 8.64e15 ? pace.hours_to_reset : null;
  // Overage readings above 1000% are malformed, as in spend.ts and runway-read.ts.
  return { pool, resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : hours !== null ? new Date(now + hours * 3_600_000).toISOString() : null, usedPercent: number(pace.used_pct) && pace.used_pct <= 1000 ? pace.used_pct : null,
    burnPerHour: number(pace.burn_pct_per_hour) ? pace.burn_pct_per_hour : null,
    hoursToReset: hours };
}

/** A controller tick may republish a stale reading; both freshness checks are required. */
export function projectUsagePace(raw: unknown, now = Date.now()): PaceSnapshot {
  const { status, fresh, asOf, budget } = parseDispatchStatusEnvelope(raw, now);
  const lanes = object(status.lanes) ? status.lanes : {};
  const admission = object(status.admission) ? status.admission : {};
  const names = fresh ? paceLaneNames(budget) : [...PACE_POOLS];
  const shareNames = [...new Set([...PACE_POOLS, 'claude-api', ...Object.keys(budget).filter(name => name !== 'codex-cmp' && POOL_NAME.test(name)).sort()])].slice(0, MAX_POOLS);
  const shares = poolShareSnapshot(shareNames.map(pool => shareInput(pool, budget[pool], now, fresh)), asOf);
  return { v: 1, asOf, shares, pools: names.map(pool => {
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

/** The dispatchd status file, read with a 1 MiB bound (also when the file grows); null when missing, oversized or not JSON. */
export async function readDispatchStatus(path: string, openFile: typeof open = open): Promise<unknown> {
  try {
    const handle = await openFile(path, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > 1024 * 1024) return null;
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) as unknown;
    } finally { await handle.close(); }
  } catch { return null; }
}

export async function readUsagePace(path = join(homedir(), '.ashlr-runs', 'queue', 'status.json'), openFile: typeof open = open): Promise<PaceSnapshot> {
  return projectUsagePace(await readDispatchStatus(path, openFile));
}
