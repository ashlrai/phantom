/**
 * Pool projection. Grok Ultra is one weekly estimate: a config snapshot plus
 * later per-run usage, split by orchestrator and cloud-agent. The quota is
 * not readable from an API.
 */

import type { TierFloor } from '../../../resources/pool-spend.js';
import type { GrokUltraDefaults, SchedulerConfig } from './defaults.js';
import {
  SCHEDULER_POOL_IDS,
  type HostState,
  type SchedulerPoolId,
  type UltraConsumer,
  type UltraUsageEvent,
} from './types.js';

const TIER_RANK: Readonly<Record<TierFloor, number>> = { local: 0, cheap: 1, workhorse: 2, frontier: 3 };

export interface UltraProjection {
  remaining: number;
  usedFraction: number;
  /** Snapshot portion still inside this window. Not split by consumer. */
  unsplitUsedFraction: number;
  orchestrator: number;
  cloudAgent: number;
  resetAtMs: number;
  estimate: true;
  source: string;
  label: string;
  extraUsageCredits: boolean;
  quotaReadableFromApi: false;
}

export interface RuntimePool {
  id: SchedulerPoolId;
  billing: SchedulerConfig['pools'][SchedulerPoolId]['billing'];
  tier: TierFloor;
  host: 'mac' | 'remote';
  concurrency: number;
  monetaryCost: number;
  preferencePenalty: number;
  unlimited: boolean;
  /** Null when the live balance is unknown. */
  remaining: number | null;
  usedToday: number;
  softCapPerDay: number;
  expiresAtMs: number | null;
  resetAtMs: number | null;
  resetEveryMs: number | null;
  carryover: boolean;
  headroomPercent: number | null;
  enabled: boolean;
  estimate: boolean;
  estimateSource: string | null;
}

export function tierRank(tier: TierFloor): number {
  return TIER_RANK[tier];
}

export function projectUltra(config: SchedulerConfig, events: readonly UltraUsageEvent[], nowMs: number): UltraProjection {
  const ultra = config.grokUltraWeekly;
  const resetEveryMs = ultra.resetEveryDays * 86_400_000;
  let resetAtMs = Date.parse(ultra.resetAt);
  if (!Number.isFinite(resetAtMs)) resetAtMs = nowMs + resetEveryMs;
  if (nowMs >= resetAtMs) {
    const steps = Math.floor((nowMs - resetAtMs) / resetEveryMs) + 1;
    resetAtMs += steps * resetEveryMs;
  }
  const windowStart = resetAtMs - resetEveryMs;
  const asOf = Date.parse(ultra.usedFractionAsOf);
  const snapshotInWindow = Number.isFinite(asOf) && asOf >= windowStart && asOf < resetAtMs && asOf <= nowMs;
  const unsplit = snapshotInWindow ? ultra.usedFraction : 0;
  let orchestrator = 0;
  let cloudAgent = 0;
  for (const event of events) {
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || ts < windowStart || ts > nowMs || ts >= resetAtMs) continue;
    if (snapshotInWindow && ts <= asOf) continue;
    if (!Number.isFinite(event.fraction) || event.fraction <= 0) continue;
    if (event.consumer === 'orchestrator') orchestrator += event.fraction;
    else cloudAgent += event.fraction;
  }
  const usedFraction = Math.min(1, Math.max(0, unsplit + orchestrator + cloudAgent));
  return {
    remaining: Math.max(0, 1 - usedFraction),
    usedFraction,
    unsplitUsedFraction: unsplit,
    orchestrator,
    cloudAgent,
    resetAtMs,
    estimate: true,
    source: config.source,
    label: ultra.label,
    extraUsageCredits: ultra.extraUsageCredits,
    quotaReadableFromApi: false,
  };
}

export function buildRuntimePools(input: {
  config: SchedulerConfig;
  events: readonly UltraUsageEvent[];
  nowMs: number;
  inFlight?: Readonly<Record<string, number>>;
}): { pools: RuntimePool[]; ultra: UltraProjection } {
  const ultra = projectUltra(input.config, input.events, input.nowMs);
  const pools = SCHEDULER_POOL_IDS.map((id) => runtimePool(input.config, id, ultra, input.config.grokUltraWeekly));
  return { pools, ultra };
}

function runtimePool(config: SchedulerConfig, id: SchedulerPoolId, ultra: UltraProjection, ultraConfig: GrokUltraDefaults): RuntimePool {
  const row = config.pools[id];
  if (id === 'grok-ultra-weekly') {
    return {
      id,
      billing: row.billing,
      tier: row.tier,
      host: row.host,
      concurrency: row.concurrency,
      monetaryCost: row.monetaryCost,
      preferencePenalty: row.preferencePenalty,
      unlimited: false,
      remaining: ultra.remaining,
      usedToday: 0,
      softCapPerDay: row.softCapPerDay,
      expiresAtMs: null,
      resetAtMs: ultra.resetAtMs,
      resetEveryMs: ultraConfig.resetEveryDays * 86_400_000,
      carryover: ultraConfig.extraUsageCredits,
      headroomPercent: row.headroomPercent ?? Math.round(ultra.remaining * 100),
      enabled: row.enabled && row.live,
      estimate: true,
      estimateSource: ultra.label,
    };
  }
  return {
    id,
    billing: row.billing,
    tier: row.tier,
    host: row.host,
    concurrency: row.concurrency,
    monetaryCost: row.monetaryCost,
    preferencePenalty: row.preferencePenalty,
    unlimited: row.unlimited,
    remaining: row.remaining,
    usedToday: row.usedToday,
    softCapPerDay: row.softCapPerDay,
    expiresAtMs: row.expiresAt === null ? null : Date.parse(row.expiresAt),
    resetAtMs: row.resetAt === null ? null : Date.parse(row.resetAt),
    resetEveryMs: null,
    carryover: true,
    headroomPercent: row.headroomPercent,
    enabled: row.enabled && row.live,
    estimate: row.remaining === null,
    estimateSource: row.remaining === null ? 'balance unknown' : null,
  };
}

export function hostBlocks(pool: RuntimePool, host: HostState, config: SchedulerConfig): boolean {
  if (pool.host !== 'mac') return false;
  if (host.diskFreeGb !== null && host.diskFreeGb < config.diskFloorGb) return true;
  if (host.batteryPercent !== null && host.batteryPercent < config.batteryFloorPercent) return true;
  return false;
}

export function poolOpen(pool: RuntimePool, nowMs: number): boolean {
  if (!pool.enabled) return false;
  if (pool.concurrency <= 0) return false;
  if (pool.expiresAtMs !== null && Number.isFinite(pool.expiresAtMs) && pool.expiresAtMs <= nowMs) return false;
  if (!pool.unlimited && pool.remaining !== null && pool.remaining <= 0) return false;
  if (!pool.unlimited && pool.remaining === null && pool.usedToday >= pool.softCapPerDay) return false;
  return true;
}

/** Use-it-or-lose-it urgency in [0, 1]. Unknown deadlines add nothing. */
export function loseItUrgency(pool: RuntimePool, nowMs: number): number {
  const deadlines: number[] = [];
  if (pool.expiresAtMs !== null && Number.isFinite(pool.expiresAtMs) && pool.expiresAtMs > nowMs) {
    const reset = pool.resetAtMs;
    if (reset === null || !Number.isFinite(reset) || pool.expiresAtMs < reset) deadlines.push(pool.expiresAtMs);
  }
  if (!pool.carryover && pool.resetAtMs !== null && Number.isFinite(pool.resetAtMs) && pool.resetAtMs > nowMs) {
    deadlines.push(pool.resetAtMs);
  }
  if (deadlines.length === 0) return 0;
  const deadline = Math.min(...deadlines);
  const window = pool.resetEveryMs ?? 7 * 86_400_000;
  const left = deadline - nowMs;
  return Math.max(0, Math.min(1, 1 - left / window));
}

export type { UltraConsumer };
