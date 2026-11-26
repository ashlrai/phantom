import type { EngineId, EngineTier } from '../types.js';
import { BUDGET_POOLS, type BudgetPool, type PoolBudgetSnapshot } from './pool-budget.js';
import type { RouteDecision } from './router.js';

export const LANE_BACKENDS: Readonly<Record<BudgetPool, EngineId | null>> = {
  'codex-personal': 'codex', devin: null, claude: 'claude',
  'grok-build': 'grok', 'grok-ultra': 'grok', 'local-omlx': 'local-coder',
};
export type LaneSlots = Partial<Record<BudgetPool, number | null>>;
/** Advisory measured quality from the pass^k suite (eval.lane-scores.v1); a
 * pool without a measured row stays unknown — null, never defaulted. */
export interface LaneEvalScore { pass1: number; passPowK: number | null; trials: number }
export type LaneEvalScores = Partial<Record<BudgetPool, LaneEvalScore>>;
export interface LaneResourceSnapshot {
  budgets: PoolBudgetSnapshot;
  /** Collected by routeBackend outside this pure projection; missing routes are unknown. */
  routes: Partial<Record<BudgetPool, RouteDecision>>;
  /** Optional pass^k evidence per pool; advisory only, never creates capacity. */
  evalScores?: LaneEvalScores;
  /** Lane -> plain reason, for lanes whose own wrapper holds every launch (lane-held.ts). Skipped until it clears. */
  selfHeld?: Readonly<Record<string, string>>;
}
/** The self-held lanes rankLanes skips, as `{pool, reason}`. */
export function selfHeldSkips(selfHeld: LaneResourceSnapshot['selfHeld']): Array<{ pool: BudgetPool; reason: string }> {
  return BUDGET_POOLS.flatMap(pool => selfHeld?.[pool] ? [{ pool, reason: selfHeld[pool]! }] : []);
}
export interface RankedLane { pool: BudgetPool; backend: EngineId; availableSlots: number; resetAt: string | null;
  projectedExhaustion: string | null; spillRecommended: boolean;
  /** Latest pass^k evidence for this lane's pool, when published. */
  evalScore: LaneEvalScore | null }

/** Prefer another eligible lane when exhaustion is expected within one hour. */
const SPILL_HORIZON_MS = 60 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1000;

/** Advisory only: no reservation or dispatch authority. Unknown evidence never creates capacity. */
export function rankLanes(tier: EngineTier, resourceSnapshot: LaneResourceSnapshot, laneSlots: LaneSlots): RankedLane[] {
  const { budgets, routes, evalScores } = resourceSnapshot;
  const now = Date.parse(budgets.timestamp);
  if (!['local', 'mid', 'frontier'].includes(tier) || budgets.sourceState !== 'healthy' || !Number.isFinite(now)) return [];
  const ranked: RankedLane[] = [];
  for (const pool of BUDGET_POOLS) {
    if (resourceSnapshot.selfHeld?.[pool]) continue;
    const slots = laneSlots[pool];
    const route = routes[pool];
    const view = budgets.pools[pool];
    if (!Number.isSafeInteger(slots) || slots! <= 0 || !route || route.tier !== tier ||
        route.backend !== LANE_BACKENDS[pool] || !view || view.mode === 'held') continue;
    const buckets = Object.values(view.buckets);
    const observed = buckets.filter(b => b.state === 'observed').map(bucket => ({
      bucket,
      observedAt: bucket.timestamp === null ? NaN : Date.parse(bucket.timestamp),
      resetAt: bucket.resetAt === null ? null : Date.parse(bucket.resetAt),
    }));
    // Follow pool-budget's tightest observed bucket; never assume a refill after reset.
    if (!observed.length || buckets.some(b => b.state === 'reset-pending') || observed.some(({ bucket, observedAt, resetAt }) =>
      bucket.remaining === null || !Number.isFinite(bucket.remaining) || bucket.remaining <= 0 ||
      !Number.isFinite(observedAt) || observedAt > now ||
      (resetAt !== null && (!Number.isFinite(resetAt) || resetAt <= now)) ||
      (now - observedAt > MAX_OBSERVATION_AGE_MS && !(bucket.source === 'manual' && resetAt !== null)))) continue;
    const resets = observed.flatMap(({ resetAt }) => resetAt === null ? [] : [resetAt]);
    const forecasts = observed.flatMap(({ bucket, observedAt, resetAt }) => {
      const at = bucket.projectedExhaustion === null ? NaN : Date.parse(bucket.projectedExhaustion);
      return Number.isFinite(at) && now - observedAt <= MAX_OBSERVATION_AGE_MS &&
        (resetAt === null || at < resetAt) ? [at] : [];
    });
    const exhaustion = forecasts.length ? Math.min(...forecasts) : null;
    ranked.push({ pool, backend: route.backend, availableSlots: slots!,
      resetAt: resets.length ? new Date(Math.min(...resets)).toISOString() : null,
      projectedExhaustion: exhaustion === null ? null : new Date(exhaustion).toISOString(),
      spillRecommended: exhaustion !== null && exhaustion <= now + SPILL_HORIZON_MS,
      evalScore: evalScores?.[pool] ?? null });
  }
  return ranked.sort((a, b) => Number(a.spillRecommended) - Number(b.spillRecommended) || (a.resetAt === null ? Infinity : Date.parse(a.resetAt)) -
    (b.resetAt === null ? Infinity : Date.parse(b.resetAt)) || BUDGET_POOLS.indexOf(a.pool) - BUDGET_POOLS.indexOf(b.pool));
}
