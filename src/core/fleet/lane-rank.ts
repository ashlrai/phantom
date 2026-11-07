import type { EngineId, EngineTier } from '../types.js';
import { BUDGET_POOLS, type BudgetPool, type PoolBudgetSnapshot } from './pool-budget.js';
import type { RouteDecision } from './router.js';

export const LANE_BACKENDS: Readonly<Record<BudgetPool, EngineId | null>> = {
  'codex-cmp': 'codex', 'codex-personal': 'codex', devin: null, claude: 'claude',
  'grok-build': 'grok', 'grok-ultra': 'grok', 'local-omlx': 'local-coder',
};
export type LaneSlots = Partial<Record<BudgetPool, number | null>>;
export interface LaneResourceSnapshot {
  budgets: PoolBudgetSnapshot;
  /** Collected by routeBackend outside this pure projection; missing routes are unknown. */
  routes: Partial<Record<BudgetPool, RouteDecision>>;
}
export interface RankedLane { pool: BudgetPool; backend: EngineId; availableSlots: number; resetAt: string | null;
  projectedExhaustion: string | null; spillRecommended: boolean }

/** Prefer another eligible lane when exhaustion is expected within one hour. */
const SPILL_HORIZON_MS = 60 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1000;

/** Advisory only: no reservation or dispatch authority. Unknown evidence never creates capacity. */
export function rankLanes(tier: EngineTier, resourceSnapshot: LaneResourceSnapshot, laneSlots: LaneSlots): RankedLane[] {
  const { budgets, routes } = resourceSnapshot;
  const now = Date.parse(budgets.timestamp);
  if (!['local', 'mid', 'frontier'].includes(tier) || budgets.sourceState !== 'healthy' || !Number.isFinite(now)) return [];
  const ranked: RankedLane[] = [];
  for (const pool of BUDGET_POOLS) {
    const slots = laneSlots[pool];
    const route = routes[pool];
    const view = budgets.pools[pool];
    if (!Number.isSafeInteger(slots) || slots! <= 0 || !route || route.tier !== tier ||
        route.backend !== LANE_BACKENDS[pool] || !view || view.mode === 'held') continue;
    const buckets = Object.values(view.buckets);
    const observed = buckets.filter(b => b.state === 'observed');
    // Follow pool-budget's tightest observed bucket; never assume a refill after reset.
    if (!observed.length || buckets.some(b => b.state === 'reset-pending') || observed.some(b =>
      typeof b.remaining !== 'number' || !Number.isFinite(b.remaining) || b.remaining <= 0 ||
      !b.timestamp || !Number.isFinite(Date.parse(b.timestamp)) || Date.parse(b.timestamp) > now ||
      b.resetAt !== null && (!Number.isFinite(Date.parse(b.resetAt)) || Date.parse(b.resetAt) <= now))) continue;
    const resets = observed.flatMap(b => b.resetAt === null ? [] : [Date.parse(b.resetAt)]);
    const forecasts = observed.flatMap(b => {
      const at = b.projectedExhaustion && Date.parse(b.projectedExhaustion);
      const observedAt = b.timestamp && Date.parse(b.timestamp);
      return typeof at === 'number' && Number.isFinite(at) && typeof observedAt === 'number' &&
        now - observedAt <= MAX_OBSERVATION_AGE_MS && (b.resetAt === null || at < Date.parse(b.resetAt)) ? [at] : [];
    });
    const exhaustion = forecasts.length ? Math.min(...forecasts) : null;
    ranked.push({ pool, backend: route.backend, availableSlots: slots!,
      resetAt: resets.length ? new Date(Math.min(...resets)).toISOString() : null,
      projectedExhaustion: exhaustion === null ? null : new Date(exhaustion).toISOString(),
      spillRecommended: exhaustion !== null && exhaustion <= now + SPILL_HORIZON_MS });
  }
  return ranked.sort((a, b) => Number(a.spillRecommended) - Number(b.spillRecommended) || (a.resetAt === null ? Infinity : Date.parse(a.resetAt)) -
    (b.resetAt === null ? Infinity : Date.parse(b.resetAt)) || BUDGET_POOLS.indexOf(a.pool) - BUDGET_POOLS.indexOf(b.pool));
}
