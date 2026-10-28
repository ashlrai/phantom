/**
 * types.ts — contracts for the contextual Thompson-sampling lane bandit
 * (RQ-SELFOPT-BANDIT-ROUTER).
 *
 * Domain: the router queue assigns every READY line a static `pool=`. The
 * bandit replaces that static choice with a learned one. A queue line carries
 * the context the task spec fixes — line size, repo, tier and pool — where
 * `pool` is the pool the line was DECLARED for (the static router's own
 * answer, kept as a feature: the bandit learns when the declaration was a
 * good default and when it was not). The arms it chooses among are LANES;
 * each lane spends against a named pool's credit plan.
 *
 * These types are deliberately free of I/O concerns: selection, update and
 * replay are pure over caller-supplied state. `flag.ts` owns where the mode
 * and configuration are read from; `rewards.ts` owns the outcome-log record
 * the queue's recorder writes.
 */

/** Line-size buckets. `sizeEdges` in the config maps line counts to them. */
export type LaneSizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl';
export const LANE_SIZE_BUCKETS: readonly LaneSizeBucket[] = Object.freeze(['xs', 's', 'm', 'l', 'xl']);

/**
 * The context of one queue line. `pool` is the line's declared pool — a
 * feature of the line, not the bandit's answer.
 */
export interface LaneContext {
  readonly sizeBucket: LaneSizeBucket;
  readonly repo: string;
  readonly tier: string;
  readonly pool: string;
}

/**
 * One arm. `id` is the lane identity the outcome log records; `pool` names
 * the credit plan the lane spends against. A lane that spends on its own
 * plan simply repeats its id (`{id:'devin', pool:'devin'}`) — the common
 * degenerate case where pools are the lanes.
 */
export interface BanditLane {
  readonly id: string;
  readonly pool: string;
}

/**
 * Per-pool credit headroom for the floor check: remaining units keyed by
 * pool id. A pool absent from `remaining` has UNKNOWN headroom and routes no
 * bandit pick — the floor fails closed, never open.
 */
export interface CreditPlan {
  readonly remaining: Readonly<Record<string, number>>;
  /** Optional per-call override of the configured floor. */
  readonly floor?: number;
}

/** Reward shaping weights; see rewards.ts for the exact formula. */
export interface RewardWeights {
  /** Success component: 1 when merged within 24h with green CI. */
  readonly success: number;
  /** Penalty weight applied to normalized per-PR cost. */
  readonly cost: number;
  /** Penalty weight applied to normalized CI wall time. */
  readonly wall: number;
  /** Cost (USD) that saturates the cost penalty. */
  readonly costNormUsd: number;
  /** CI wall time (ms) that saturates the wall penalty. */
  readonly wallNormMs: number;
}

/** Bandit hyperparameters; flag.ts fills the defaults. */
export interface BanditConfig {
  /** Minimum observations at a context level before its posterior is used. */
  readonly minCellSamples: number;
  /** Beta prior: Beta(priorAlpha, priorBeta) — default uniform Beta(1,1). */
  readonly priorAlpha: number;
  readonly priorBeta: number;
  /** Minimum remaining credits a pool must hold for its lanes to be eligible. */
  readonly creditFloor: number;
  /** Ascending line-count edges for the five size buckets. */
  readonly sizeEdges: readonly number[];
  readonly reward: RewardWeights;
}

export const DEFAULT_REWARD_WEIGHTS: Readonly<RewardWeights> = Object.freeze({
  success: 1,
  cost: 0.25,
  wall: 0.25,
  costNormUsd: 10,
  wallNormMs: 3_600_000,
});

export const DEFAULT_SIZE_EDGES: readonly number[] = Object.freeze([150, 400, 1200, 3600]);

export const DEFAULT_BANDIT_CONFIG: Readonly<BanditConfig> = Object.freeze({
  minCellSamples: 4,
  priorAlpha: 1,
  priorBeta: 1,
  creditFloor: 0,
  sizeEdges: DEFAULT_SIZE_EDGES,
  reward: DEFAULT_REWARD_WEIGHTS,
});

/** Feature-flag modes. Default (and the spec's default) is `shadow`. */
export type BanditMode = 'off' | 'shadow' | 'enforce';

export const BANDIT_MODES: readonly BanditMode[] = Object.freeze(['off', 'shadow', 'enforce']);

/**
 * One routing decision. `laneId` is the applied pick — the declared lane in
 * off/shadow mode, the bandit's sample in enforce mode, null when the
 * decision is a hold. `sampledLaneId` is what the bandit WOULD have chosen
 * (always recorded in shadow mode so divergence is measurable before the
 * flag is promoted).
 */
export interface LaneDecision {
  readonly mode: BanditMode;
  /** The lane the caller should route to; null = hold. */
  readonly laneId: string | null;
  /** The bandit's Thompson pick among eligible lanes; null when not consulted. */
  readonly sampledLaneId: string | null;
  /** Whether sampled ≠ applied (the shadow-mode divergence signal). */
  readonly divergent: boolean;
  /** Lane ids that satisfied the credit floor (order = input order). */
  readonly eligibleLaneIds: readonly string[];
  /** Why the decision is a hold, or null. A hold routes nowhere. */
  readonly holdReason: string | null;
  readonly reason: string;
}

/** Per-cell posterior for one arm, serialized in bandit state. */
export interface ArmPosterior {
  a: number;
  b: number;
  n: number;
}

export interface BanditState {
  readonly v: 1;
  /** context-level key → lane id → posterior. */
  readonly cells: Readonly<Record<string, Readonly<Record<string, ArmPosterior>>>>;
}
