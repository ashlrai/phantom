/**
 * Pick a spend pool for coding work. The pool spend order comes from the pool
 * ranker. Within the winning billing class, the existing seat router breaks
 * headroom ties, including reset spend-down and in-flight spread. The tier
 * floor from the job shape is a minimum. Pure: callers pass pools, the clock
 * and in-flight counts; this module reads nothing.
 */

import type { JobShape } from '../decide/job-shape.js';
import type { SeatCapacity } from '../routing/headroom.js';
import { defaultBudgetPolicy, type BudgetEngine } from '../routing/policy.js';
import { routeSeat } from '../routing/router.js';
import type { AccountSchedulingView } from '../routing/scheduling-types.js';
import type { BudgetPolicy, RoutingRequest, SeatDecision } from '../routing/types.js';
import { rankSpendPools, type SpendPool, type TierFloor } from './pool-spend.js';

/** A harder job never gets a cheaper floor. Risk lifts the floor like complexity. */
export function jobShapeFloor(shape: JobShape): TierFloor {
  if (shape.complexity === 'high' || shape.risk === 'high') return 'frontier';
  if (shape.complexity === 'low' && shape.risk === 'low') return 'cheap';
  return 'workhorse';
}

function engineOfPool(pool: SpendPool): BudgetEngine {
  if (pool.lane === 'devin' || pool.id === 'devin-acu') return 'devin';
  if (pool.lane === 'grok-subscription' || pool.id.startsWith('grok')) return 'grok';
  if (pool.billing === 'local' || pool.lane === 'local-omlx' || pool.lane === 'local-fallback') return 'local';
  if (pool.id.startsWith('omlx:') || pool.id.startsWith('ollama:')) return 'local';
  if (pool.id === 'cloud-credits' || pool.id.startsWith('claude')) return 'claude';
  return 'codex';
}

/**
 * Project a spend pool to a seat for the router's headroom ranking. A local
 * pool is a free seat. Any other pool with unknown headroom stays out of the
 * seat pass — an unread usage is not evidence of room.
 */
export function spendPoolSeat(
  pool: SpendPool,
  nowMs: number,
  meteredEnabled: boolean,
  engine: BudgetEngine = engineOfPool(pool),
): SeatCapacity | null {
  if (pool.billing === 'local' || engine === 'local') {
    return {
      seatId: pool.id,
      engine: 'local',
      label: pool.id,
      free: true,
      windows: [],
      signedOut: false,
      reachable: true,
      contextWindow: 65_536,
      observedAt: null,
      spentTodayUsd: null,
      costBasis: 'free',
      billingClass: 'local',
    };
  }
  if (pool.headroomPercent === null) return null;
  const used = Math.max(0, Math.min(100, 100 - pool.headroomPercent));
  const metered = pool.billing === 'metered' || pool.billing === 'credit';
  return {
    seatId: pool.id,
    engine,
    label: pool.id,
    free: false,
    windows: [{
      id: engine === 'codex' ? 'codex_codex_secondary' : engine === 'grok' ? 'grok_unified_weekly' : 'seven_day',
      usedPercent: used,
      resetsAt: pool.expiresAt,
      resetDescription: null,
      limitReached: false,
    }],
    signedOut: false,
    reachable: null,
    contextWindow: 200_000,
    observedAt: new Date(nowMs).toISOString(),
    spentTodayUsd: null,
    costBasis: metered ? 'per-token' : 'subscription',
    billingClass: metered ? 'metered' : 'subscription',
    meteredOptIn: meteredEnabled || pool.meteredOptIn === true,
  };
}

export interface SpendPoolChoice {
  pool: SpendPool;
  /** Null when no seat pass ran — a lone winner, or no pool carried a readable headroom. */
  decision: SeatDecision | null;
}

export interface ChooseSpendPoolInput {
  pools: readonly SpendPool[];
  shape: JobShape;
  nowMs: number;
  /** Global metered enable. A pool's own `meteredOptIn` still admits it. */
  meteredEnabled?: boolean;
  /** In-flight runs per pool id. Lower count wins a headroom tie. */
  inFlight?: Readonly<Record<string, number>>;
  /** Per-pool reset views for the spend-down tie. Absent leaves score order. */
  scheduling?: Readonly<Record<string, AccountSchedulingView>>;
  /** pool id → engine; absent derives it from lane and id. */
  engines?: Readonly<Record<string, BudgetEngine>>;
  /** Budget policy; absent is the default 'balanced' policy. */
  policy?: BudgetPolicy;
  /** Routing request override; absent derives task/difficulty from the floor. */
  request?: RoutingRequest;
}

/**
 * Rank the spendable pools, then let the seat router reorder only inside the
 * winning billing class. A lower class never beats the ranked winner's class;
 * when the seat pass finds no convertible seat the ranked order stands.
 */
export function chooseSpendPool(input: ChooseSpendPoolInput): SpendPoolChoice | null {
  const meteredEnabled = input.meteredEnabled === true;
  const floor = jobShapeFloor(input.shape);
  const ranked = rankSpendPools(input.pools, { nowMs: input.nowMs, floor, meteredEnabled });
  if (ranked.length === 0) return null;
  const kindOf = (pool: SpendPool) => (pool.billing === 'credit' && pool.expiresAt ? 'credit-dated' : pool.billing);
  const winnerKind = kindOf(ranked[0]!);
  const group = ranked.filter((pool) => kindOf(pool) === winnerKind);
  let chosen = group[0]!;
  let decision: SeatDecision | null = null;
  if (group.length > 1) {
    const seats = group.flatMap((pool) => {
      const seat = spendPoolSeat(pool, input.nowMs, meteredEnabled, input.engines?.[pool.id] ?? engineOfPool(pool));
      return seat ? [seat] : [];
    });
    if (seats.length > 0) {
      const request: RoutingRequest = input.request ?? {
        task: floor === 'cheap' ? 'bulk' : 'code',
        difficulty: floor === 'frontier' ? 'high' : floor === 'cheap' ? 'low' : 'medium',
        autonomous: true,
        contextTokens: input.shape.contextTokens,
      };
      decision = routeSeat(request, seats, input.policy ?? defaultBudgetPolicy(), {
        nowMs: input.nowMs,
        enforceMeteredOptIn: true,
        spendDown: true,
        ...(input.inFlight ? { inFlight: input.inFlight } : {}),
        ...(input.scheduling ? { scheduling: input.scheduling } : {}),
      });
      const seatId = decision.seatId;
      const match = seatId ? group.find((pool) => pool.id === seatId) : undefined;
      if (match) chosen = match;
    }
  }
  return { pool: chosen, decision };
}
