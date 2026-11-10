/**
 * Types for the coding-pool scheduler. Pools, jobs and decisions are plain
 * data. Nothing here reads the network, the home directory, or a secret.
 */

import type { TierFloor } from '../../../resources/pool-spend.js';

export const SCHEDULER_POOL_IDS = [
  'codex-primary',
  'codex-secondary',
  'claude',
  'devin',
  'grok-build',
  'local',
  'grok-ultra-weekly',
  'metered',
] as const;

export type SchedulerPoolId = (typeof SCHEDULER_POOL_IDS)[number];

/** Consumers of the one Grok Ultra weekly limit. Not separate pools. */
export const ULTRA_CONSUMERS = ['orchestrator', 'cloud-agent'] as const;
export type UltraConsumer = (typeof ULTRA_CONSUMERS)[number];

export const JOB_KINDS = [
  'coding',
  'investigation',
  'test-fixing',
  'research',
  'orchestration',
  'review',
  'merge-decision',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const HEAVY_JOB_KINDS = ['coding', 'investigation', 'test-fixing', 'research'] as const;
export type HeavyJobKind = (typeof HEAVY_JOB_KINDS)[number];

/** Planning role. Merge and credential are never granted by an assignment. */
export const SCHEDULER_ROLES = ['produce', 'review', 'merge', 'credential', 'orchestration'] as const;
export type SchedulerRole = (typeof SCHEDULER_ROLES)[number];

export type PoolHost = 'mac' | 'remote';

export interface SchedulerJob {
  id: string;
  jobType: JobKind;
  /** Defaults from the job type. */
  role?: SchedulerRole;
  /** Defaults from the job type. Main merge decisions are frontier. */
  minTier?: TierFloor;
  /** Demand in the pool's unit. Grok Ultra defaults to the configured fraction. */
  quotaByPool?: Partial<Record<SchedulerPoolId, number>>;
  /** When true, a job with no eligible pool makes the model infeasible. */
  requireAssignment?: boolean;
}

export interface UltraUsageEvent {
  ts: string;
  consumer: UltraConsumer;
  /** Fraction of the weekly pool, added after the configured snapshot. */
  fraction: number;
}

export interface HostState {
  diskFreeGb: number | null;
  batteryPercent: number | null;
}

export interface ArmState {
  alpha: number;
  beta: number;
  qualityMean: number;
  qualityM2: number;
  latencyMean: number;
  latencyM2: number;
  tokenMean: number;
  tokenM2: number;
  tokenObservations: number;
  observations: number;
}

export interface BanditState {
  id: string;
  arms: Readonly<Record<string, ArmState>>;
}

export interface RouterOutcome {
  ts: string;
  jobId: string;
  jobType: JobKind;
  poolId: SchedulerPoolId;
  consumer: UltraConsumer | null;
  merged: boolean;
  green: boolean;
  reviewRounds: number;
  reverted: boolean;
  tokens: number | null;
  wallMs: number;
  cost: number | null;
  propensity: number | null;
}

export interface EligibleRef {
  poolId: SchedulerPoolId;
  consumer: UltraConsumer | null;
}

export interface RouterDecision {
  ts: string;
  jobId: string;
  jobType: JobKind;
  poolId: SchedulerPoolId | null;
  consumer: UltraConsumer | null;
  policyId: string;
  canary: boolean;
  propensity: number;
  solver: 'highs' | 'greedy';
  fallback: boolean;
  /** Always false. The scheduler does not grant merge authority. */
  grantsMergeAuthority: false;
  netValue: number | null;
  eligible: readonly EligibleRef[];
}

export interface Assignment {
  jobId: string;
  poolId: SchedulerPoolId;
  consumer: UltraConsumer | null;
  netValue: number;
  monetaryCost: number;
  grantsMergeAuthority: false;
}

export type SolverStatus = 'optimal' | 'infeasible' | 'failed' | 'timeout';

export interface SolverOutcome {
  status: SolverStatus;
  objective: number | null;
  /** Variable name to primal value. Present for an optimal solve. */
  values: Readonly<Record<string, number>>;
}

export type MilpSolver = (lp: string, budgetMs: number) => Promise<SolverOutcome>;

export function isSchedulerPoolId(value: string): value is SchedulerPoolId {
  return (SCHEDULER_POOL_IDS as readonly string[]).includes(value);
}

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

export function isUltraConsumer(value: string): value is UltraConsumer {
  return (ULTRA_CONSUMERS as readonly string[]).includes(value);
}

export function armKey(jobType: JobKind, poolId: SchedulerPoolId, consumer: UltraConsumer | null): string {
  return `${jobType}\u0000${poolId}\u0000${consumer ?? ''}`;
}
