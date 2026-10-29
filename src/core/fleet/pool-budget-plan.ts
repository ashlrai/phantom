/**
 * Dispatch pacing plan: land each pool near 0% at its own reset.
 *
 * Pure projection over the advisory budget ledger. The plan never moves a
 * balance, grant or reservation; dispatchd owns real concurrency and applies
 * these decisions as direction, not authority. Weekly quota always spends
 * before credits: a credits lane opens only once the weekly lane is observed
 * exhausted, and it drains only after that point.
 */
import { RESET_TARGET_USED_PERCENT } from '../routing/reset-pressure.js';
import { BUDGET_POOLS, type BudgetBucketView, type BudgetPool, type PoolBudgetSnapshot, type PoolBudgetView } from './pool-budget.js';

const HOUR = 3_600_000;
/** Burn within this band of target counts as on pace; outside it dispatch adjusts. */
export const PACE_TOLERANCE = 0.1;
/** Grok Ultra is the scarce orchestration pool; it never shares its single slot. */
export const GROK_ULTRA_MAX_CONCURRENCY = 1;

export type PaceConcurrency = 'raise' | 'hold' | 'lower' | 'pause';
export type PaceLane = 'weekly' | 'credits' | 'metered' | 'capacity' | 'held' | 'none';

export interface PoolPaceDecision {
  pool: BudgetPool;
  /** The lane dispatch may charge now; 'none' means the pool spends nothing. */
  lane: PaceLane;
  /** True only while observed weekly allowance remains unspent. */
  weeklyOpen: boolean;
  /** True only once observed weekly allowance is exhausted and a balance remains. */
  creditsOpen: boolean;
  weeklyRemainingPct: number | null;
  creditsRemaining: number | null;
  /** Absolute units for metered lanes (Devin ACUs) and capacity lanes. */
  meteredRemaining: number | null;
  resetAt: string | null;
  hoursToReset: number | null;
  /** Burn rate that lands the lane on target at reset, in the lane's units per hour. */
  targetBurnPerHour: number | null;
  /** Fresh observed burn from the ledger, last-two then trailing-12-hour. */
  observedBurnPerHour: number | null;
  /** observed / target; null when either side is unknown or the target is zero. */
  paceRatio: number | null;
  concurrency: PaceConcurrency;
  /** Advisory ceiling for dispatchd; null when the plan does not bound the pool. */
  maxConcurrency: number | null;
  reasons: string[];
}

export interface PoolBudgetPlan {
  schema: 'fleet.budget-plan.v1';
  timestamp: string;
  sourceState: PoolBudgetSnapshot['sourceState'];
  targetUsedPercent: number;
  /** Fraction of target burn either side of which still counts as on pace. */
  tolerance: number;
  decisions: Record<BudgetPool, PoolPaceDecision>;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function freshBurn(bucket: BudgetBucketView): number | null {
  const burn = bucket.burnPerHour.last2 ?? bucket.burnPerHour.last12h;
  return burn !== null && Number.isFinite(burn) && burn >= 0 ? burn : null;
}

function baseDecision(pool: BudgetPool, view: PoolBudgetView): PoolPaceDecision {
  return {
    pool,
    lane: 'none',
    weeklyOpen: false,
    creditsOpen: false,
    weeklyRemainingPct: view.remainingWeeklyPct,
    creditsRemaining: view.remainingCredits,
    meteredRemaining: null,
    resetAt: null,
    hoursToReset: null,
    targetBurnPerHour: null,
    observedBurnPerHour: null,
    paceRatio: null,
    concurrency: 'hold',
    maxConcurrency: pool === 'grok-ultra' ? GROK_ULTRA_MAX_CONCURRENCY : null,
    reasons: [],
  };
}

/**
 * Receding-horizon pace for one spend lane. `margin` is the allowance share
 * deliberately left unspent at reset (the 98% landing target leaves 2 points
 * of a weekly window; absolute-unit budgets keep no margin).
 */
function paceLane(decision: PoolPaceDecision, lane: 'weekly' | 'metered', input: {
  remaining: number; resetAt: string | null; observed: number | null; margin: number;
  unitLabel: string; nowMs: number; target: number;
}): void {
  const { remaining, resetAt, observed, margin, unitLabel, nowMs, target } = input;
  const resetMs = resetAt === null ? NaN : Date.parse(resetAt);
  const hoursToReset = Number.isFinite(resetMs) && resetMs > nowMs ? (resetMs - nowMs) / HOUR : null;
  decision.lane = lane;
  decision.resetAt = resetAt;
  decision.hoursToReset = hoursToReset === null ? null : round6(hoursToReset);
  decision.observedBurnPerHour = observed === null ? null : round6(observed);
  if (hoursToReset === null) {
    decision.concurrency = 'hold';
    decision.reasons.push(resetAt === null
      ? `${unitLabel} reset is unknown; hold concurrency until a reset is observed.`
      : `${unitLabel} reset already passed; hold concurrency until a fresh reading lands.`);
    return;
  }
  const spendable = Math.max(0, remaining - margin);
  const targetBurn = spendable / hoursToReset;
  decision.targetBurnPerHour = round6(targetBurn);
  if (targetBurn <= 0) {
    decision.concurrency = observed !== null && observed > 0 ? 'lower' : 'hold';
    decision.reasons.push(observed !== null && observed > 0
      ? `Lane is at the ${target}% landing target; lower concurrency to protect the remaining margin.`
      : `Lane is at the ${target}% landing target; hold concurrency.`);
    return;
  }
  if (observed === null) {
    decision.concurrency = 'raise';
    decision.reasons.push(`No burn observed in this window; raise toward the ${round6(targetBurn)} per-hour target.`);
    return;
  }
  const ratio = observed / targetBurn;
  decision.paceRatio = round6(ratio);
  if (ratio < 1 - PACE_TOLERANCE) {
    decision.concurrency = 'raise';
    decision.reasons.push(`Under pace: observed ${round6(observed)} per hour is below the ${round6(targetBurn)} target; raise concurrency.`);
  } else if (ratio > 1 + PACE_TOLERANCE) {
    decision.concurrency = 'lower';
    decision.reasons.push(`Over pace: observed ${round6(observed)} per hour is above the ${round6(targetBurn)} target; lower concurrency.`);
  } else {
    decision.concurrency = 'hold';
    decision.reasons.push(`On pace within ${Math.round(PACE_TOLERANCE * 100)}% of the ${round6(targetBurn)} per-hour target; hold concurrency.`);
  }
}

/** Weekly-capable pools: spend the expiring window first, gate credits behind it. */
function weeklyDecision(pool: BudgetPool, view: PoolBudgetView, decision: PoolPaceDecision, nowMs: number, target: number): void {
  const weekly = view.buckets.weeklyPct!;
  const credits = view.buckets.credits;
  decision.resetAt = weekly.resetAt;
  if (pool === 'grok-ultra') {
    decision.reasons.push('Grok Ultra is the scarce orchestration pool; never above one concurrent dispatch.');
  }
  if (weekly.state === 'unknown' || weekly.remaining === null) {
    decision.concurrency = 'hold';
    decision.reasons.push(weekly.state === 'reset-pending'
      ? 'Weekly reset passed; hold until a fresh reading lands. Credits stay closed across the refill.'
      : 'Weekly allowance is unobserved; hold until a fresh reading lands. Credits stay closed while weekly is unproven.');
    return;
  }
  if (weekly.remaining > 0) {
    decision.weeklyOpen = true;
    decision.creditsOpen = false;
    decision.reasons.push('Weekly quota spends before credits; the credits lane stays closed while weekly remains.');
    paceLane(decision, 'weekly', {
      remaining: weekly.remaining, resetAt: weekly.resetAt, observed: freshBurn(weekly),
      margin: 100 - target, unitLabel: 'Weekly window', nowMs, target,
    });
    return;
  }
  // Observed exhaustion is the only proof that opens the credits lane.
  if (credits && credits.remaining !== null && credits.remaining > 0) {
    decision.lane = 'credits';
    decision.creditsOpen = true;
    decision.concurrency = 'hold';
    decision.reasons.push('Weekly allowance is exhausted; the credits lane is open and drains only after it.',
      'Credits carry no reset pressure; hold concurrency and drain ordinarily.');
    return;
  }
  decision.concurrency = 'pause';
  decision.reasons.push(credits && credits.remaining !== null && credits.remaining <= 0
    ? 'Weekly allowance and credit balance are both exhausted; pause dispatch.'
    : 'Weekly allowance is exhausted and no spendable credit balance is observed; pause dispatch.');
}

/** Absolute-unit metered pools (Devin ACUs): pace to land at zero at reset. */
function meteredDecision(view: PoolBudgetView, decision: PoolPaceDecision, nowMs: number, target: number): void {
  const acus = view.buckets.acus!;
  decision.meteredRemaining = acus.remaining;
  if (acus.state === 'unknown' || acus.remaining === null) {
    decision.concurrency = 'hold';
    decision.reasons.push(acus.state === 'reset-pending'
      ? 'ACU reset passed; hold until a fresh reading lands.'
      : 'ACU budget is unobserved; hold until a fresh reading lands.');
    return;
  }
  if (acus.remaining <= 0) {
    decision.lane = 'metered';
    decision.concurrency = 'pause';
    decision.reasons.push('ACU budget is exhausted; pause dispatch until the reset refills it.');
    return;
  }
  paceLane(decision, 'metered', {
    remaining: acus.remaining, resetAt: acus.resetAt, observed: freshBurn(acus),
    margin: 0, unitLabel: 'ACU budget', nowMs, target,
  });
}

/**
 * Project the pacing plan for a budget snapshot. Advisory: it describes the
 * lane each pool may charge and the direction dispatch should move its
 * concurrency so the pool lands near 0% at its reset.
 */
export function projectPoolBudgetPlan(snapshot: PoolBudgetSnapshot, nowMs = Date.parse(snapshot.timestamp), target = RESET_TARGET_USED_PERCENT): PoolBudgetPlan {
  const decisions = {} as Record<BudgetPool, PoolPaceDecision>;
  const unavailable = snapshot.sourceState !== 'healthy';
  for (const pool of BUDGET_POOLS) {
    const view = snapshot.pools[pool];
    const decision = baseDecision(pool, view);
    decisions[pool] = decision;
    if (unavailable) {
      decision.concurrency = 'hold';
      decision.reasons.push('Budget ledger is unavailable; hold the last known concurrency until readings resume.');
      continue;
    }
    if (view.mode === 'held') {
      decision.lane = 'held';
      decision.concurrency = 'pause';
      decision.reasons.push('Pool is held; dispatch spends nothing here.');
      continue;
    }
    if (view.mode === 'capacity-only') {
      const capacity = view.buckets.capacity;
      decision.lane = 'capacity';
      decision.meteredRemaining = capacity?.remaining ?? null;
      decision.maxConcurrency = capacity?.remaining !== null && capacity?.remaining !== undefined
        ? Math.max(0, Math.floor(capacity.remaining)) : null;
      if (decision.maxConcurrency === 0) {
        decision.concurrency = 'pause';
        decision.reasons.push('Observed capacity is zero; pause dispatch until capacity frees.');
      } else {
        decision.concurrency = 'hold';
        decision.reasons.push('Capacity-only pool; dispatch is bounded by observed capacity, not spend-paced.');
      }
      continue;
    }
    if (view.buckets.weeklyPct) { weeklyDecision(pool, view, decision, nowMs, target); continue; }
    if (view.buckets.acus) { meteredDecision(view, decision, nowMs, target); continue; }
    decision.reasons.push('No spend lane is observed for this pool; hold concurrency.');
  }
  return {
    schema: 'fleet.budget-plan.v1',
    timestamp: new Date(nowMs).toISOString(),
    sourceState: snapshot.sourceState,
    targetUsedPercent: target,
    tolerance: PACE_TOLERANCE,
    decisions,
  };
}
