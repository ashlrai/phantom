/** Rates are jobs/second. Stages form an ordered, one-to-one pipeline. */
export interface QueueSnapshot {
  schema: 'phantom-queue-snapshot/v1';
  stream: string;
  observedAt: number;
  windowSeconds: number;
  plannerRate: number;
  targetUtilization: number;
  pools: Array<{ id: string; slots: number; available: boolean }>;
  stages: QueueStage[];
}

export interface QueueStage {
  id: string;
  kind: 'work' | 'test' | 'merge';
  pool: string;
  queued: number;
  previousQueued: number;
  arrivals: number;
  slots: number;
  minSlots: number;
  maxSlots: number;
  tier: string;
  /** Only already-authorized options; rates include all required verification. */
  tiers: Array<{ id: string; serviceRate: number }>;
  /** Advisory preflight only. Never subtract required checks from service time. */
  impact: boolean;
  batchSize: number;
  /** Measured total per-slot rates, not an assumed linear batch speedup. */
  batches: Array<{ size: number; serviceRate: number }>;
}

export interface QueueAllocation {
  stage: string;
  pool: string;
  slots: number;
  tier: string;
  impact: boolean;
  batchSize: number;
  capacity: number;
}

export interface QueueAction {
  stage: string;
  control: 'slots' | 'tier' | 'test-impact' | 'merge-batch';
  from: number | string | boolean;
  to: number | string | boolean;
  reason: string;
}

export interface QueueControlDecision {
  schema: 'phantom-queue-control/v1';
  id: string;
  observedAt: number;
  inputDigest: string;
  input: QueueSnapshot;
  bottleneck: { stage: string; reason: string; rho: number | null; growth: number } | null;
  actions: QueueAction[];
  allocations: QueueAllocation[];
  planner: { mode: 'throttle' | 'restock' | 'steady'; rate: number; reason: string };
  bandit: {
    schema: 'phantom-queue-bandit/v1';
    decisionId: string;
    context: Array<{ stage: string; queued: number; rho: number | null; growth: number }>;
    actions: QueueAction[];
    reward: null;
    status: 'awaiting-observation';
  };
  lpInputs: {
    schema: 'phantom-queue-lp-inputs/v1';
    issue: 938;
    decisionId: string;
    pools: QueueSnapshot['pools'];
    stages: Array<QueueAllocation & { backlog: number; arrivalRate: number; minSlots: number; maxSlots: number }>;
    plannerRateLimit: number;
    targetUtilization: number;
    requiredChecks: 'preserved';
  };
}
