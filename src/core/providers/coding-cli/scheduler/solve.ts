/**
 * Assign queued jobs to coding pools. The primary solver is HiGHS. A failed
 * or timed-out solve falls back to the existing greedy spend order. An
 * infeasible model stays unassigned. The wasm instance is loaded outside the
 * solve budget; the budget covers the solve call.
 */

import highsImport from 'highs';

import { roleAllowed } from '../../../routing/backend-roles.js';
import { rankSpendPools, type SpendPool, type TierFloor } from '../../../resources/pool-spend.js';
import { applyOverrides, embeddedSchedulerConfig, type SchedulerConfig, type SchedulerOverrides } from './defaults.js';
import {
  canaryBucket,
  emptyBandit,
  expectedValue,
  getArm,
  hashSeed,
  mulberry32,
  sampleValue,
} from './learn.js';
import {
  buildRuntimePools,
  hostBlocks,
  loseItUrgency,
  poolOpen,
  tierRank,
  type RuntimePool,
  type UltraProjection,
} from './pools.js';
import {
  armKey,
  type Assignment,
  type BanditState,
  type EligibleRef,
  type HostState,
  type MilpSolver,
  type RouterDecision,
  type SchedulerJob,
  type SchedulerPoolId,
  type SchedulerRole,
  type SolverOutcome,
  type UltraConsumer,
  type UltraUsageEvent,
} from './types.js';

export interface ScheduleInput {
  jobs: readonly SchedulerJob[];
  nowMs: number;
  config?: SchedulerConfig;
  overrides?: SchedulerOverrides;
  events?: readonly UltraUsageEvent[];
  host?: HostState;
  inFlight?: Readonly<Record<string, number>>;
  bandit?: BanditState;
  /** Unpromoted policy. Canary jobs are scored with it. */
  candidate?: BanditState;
  meteredEnabled?: boolean;
  devinEnabled?: boolean;
  seed?: number;
  solver?: MilpSolver;
  /** Replaces the learned value for one pair. Named so it does not collide with Object.valueOf. */
  valueOverride?: (job: SchedulerJob, poolId: SchedulerPoolId, consumer: UltraConsumer | null) => number | undefined;
}

export interface ScheduleResult {
  status: 'optimal' | 'infeasible' | 'fallback';
  solver: 'highs' | 'greedy';
  fallbackReason: 'failed' | 'timeout' | null;
  assignments: Assignment[];
  unassigned: string[];
  decisions: RouterDecision[];
  ultra: UltraProjection;
  objective: number | null;
  runwayHours: number;
}

interface Variable {
  name: string;
  jobIndex: number;
  poolId: SchedulerPoolId;
  consumer: UltraConsumer | null;
  coefficient: number;
  demand: number;
}

interface Prepared {
  config: SchedulerConfig;
  jobs: readonly SchedulerJob[];
  pools: RuntimePool[];
  ultra: UltraProjection;
  host: HostState;
  bandit: BanditState;
  candidate?: BanditState;
  meteredEnabled: boolean;
  devinEnabled: boolean;
  seed: number;
  inFlight: Readonly<Record<string, number>>;
  valueOverride?: ScheduleInput['valueOverride'];
  totalPace: number;
  cloudPace: number;
}

interface ScoredPair {
  pool: RuntimePool;
  consumer: UltraConsumer | null;
  coefficient: number;
  demand: number;
  canary: boolean;
  policyId: string;
}

interface HighsSolveResult {
  Status: string;
  ObjectiveValue: number;
  Columns: Record<string, unknown>;
}

interface HighsRuntime {
  solve(problem: string, options?: {
    output_flag?: boolean;
    time_limit?: number;
    random_seed?: number;
    presolve?: 'off' | 'choose' | 'on';
  }): HighsSolveResult;
}

type HighsLoader = () => Promise<HighsRuntime>;

/**
 * `highs` is CommonJS with an ESM default that is the loader function.
 * NodeNext types the declaration file as a namespace, so the call goes
 * through unknown and accepts either shape.
 */
function loadHighs(): Promise<HighsRuntime> {
  const imported: unknown = highsImport;
  const loader: HighsLoader = typeof imported === 'function'
    ? imported as HighsLoader
    : (imported as { default: HighsLoader }).default;
  return loader();
}

let highsPromise: Promise<HighsRuntime> | null = null;

function highsRuntime(): Promise<HighsRuntime> {
  highsPromise ??= loadHighs();
  return highsPromise;
}

/** HiGHS solve. The budget is the native time limit and a wall-clock backstop. */
export const highsSolver: MilpSolver = async (lp, budgetMs) => {
  try {
    const highs = await highsRuntime();
    const started = Date.now();
    const result = highs.solve(lp, {
      output_flag: false,
      time_limit: budgetMs / 1000,
      random_seed: 1,
      presolve: 'on',
    });
    const elapsed = Date.now() - started;
    if (result.Status === 'Infeasible') return { status: 'infeasible', objective: null, values: {} };
    if (result.Status === 'Time limit reached' || elapsed > budgetMs) {
      return { status: 'timeout', objective: null, values: {} };
    }
    if (result.Status !== 'Optimal' && result.Status !== 'Empty') {
      return { status: 'failed', objective: null, values: {} };
    }
    const values: Record<string, number> = {};
    for (const [name, column] of Object.entries(result.Columns)) {
      const primal = (column as { Primal?: unknown }).Primal;
      if (typeof primal === 'number') values[name] = primal;
    }
    return { status: 'optimal', objective: result.ObjectiveValue, values };
  } catch {
    return { status: 'failed', objective: null, values: {} };
  }
};

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roleOf(job: SchedulerJob): SchedulerRole {
  if (job.role) return job.role;
  switch (job.jobType) {
    case 'orchestration':
      return 'orchestration';
    case 'review':
      return 'review';
    case 'merge-decision':
      return 'merge';
    case 'coding':
    case 'investigation':
    case 'test-fixing':
    case 'research':
      return 'produce';
    default: {
      const neverKind: never = job.jobType;
      return neverKind;
    }
  }
}

function tierOf(job: SchedulerJob, role: SchedulerRole): TierFloor {
  if (job.minTier) return job.minTier;
  if (role === 'merge' || job.jobType === 'merge-decision') return 'frontier';
  return 'cheap';
}

function consumersOf(poolId: SchedulerPoolId): readonly (UltraConsumer | null)[] {
  if (poolId === 'grok-ultra-weekly') return ['orchestrator', 'cloud-agent'];
  return [null];
}

function allowed(role: SchedulerRole, minTier: TierFloor, pool: RuntimePool, consumer: UltraConsumer | null, prepared: Prepared, nowMs: number): boolean {
  if (!poolOpen(pool, nowMs)) return false;
  if (hostBlocks(pool, prepared.host, prepared.config)) return false;
  if (tierRank(pool.tier) < tierRank(minTier)) return false;
  if (pool.concurrency - (prepared.inFlight[pool.id] ?? 0) <= 0) return false;
  const row = prepared.config.pools[pool.id];
  if (row.requiresMeteredOptIn && prepared.meteredEnabled !== true) return false;
  if (row.requiresDevinGate && prepared.devinEnabled !== true) return false;
  if (pool.id === 'grok-ultra-weekly') {
    if (consumer === null) return false;
  } else if (consumer !== null) return false;
  switch (role) {
    case 'credential':
      return false;
    case 'merge':
      return consumer === 'orchestrator' && pool.tier === 'frontier';
    case 'orchestration':
      return consumer === 'orchestrator';
    case 'review':
      if (consumer === 'orchestrator') return true;
      if (consumer === 'cloud-agent') return false;
      return roleAllowed(pool.billing, 'review');
    case 'produce':
      if (consumer === 'orchestrator') return false;
      if (consumer === 'cloud-agent') return pool.id === 'grok-ultra-weekly';
      return roleAllowed(pool.billing, 'produce');
    default: {
      const neverRole: never = role;
      return neverRole;
    }
  }
}

function demandOf(job: SchedulerJob, pool: RuntimePool, config: SchedulerConfig): number {
  const override = job.quotaByPool?.[pool.id];
  if (override !== undefined) return Math.max(0, override);
  if (pool.id === 'grok-ultra-weekly') return config.grokUltraWeekly.jobFraction;
  return 1;
}

function learnedValue(prepared: Prepared, job: SchedulerJob, poolId: SchedulerPoolId, consumer: UltraConsumer | null, canary: boolean): { value: number; policyId: string } {
  const override = prepared.valueOverride?.(job, poolId, consumer);
  if (override !== undefined && Number.isFinite(override)) {
    return { value: override, policyId: prepared.bandit.id };
  }
  const policy = canary && prepared.candidate ? prepared.candidate : prepared.bandit;
  const arm = getArm(policy, armKey(job.jobType, poolId, consumer));
  if (canary && !prepared.candidate) {
    const rng = mulberry32(hashSeed(`${prepared.seed}:${job.id}:${poolId}:${consumer ?? ''}`));
    return { value: sampleValue(arm, rng, prepared.config), policyId: prepared.bandit.id };
  }
  return { value: expectedValue(arm, prepared.config), policyId: policy.id };
}

function coefficient(prepared: Prepared, job: SchedulerJob, role: SchedulerRole, pool: RuntimePool, consumer: UltraConsumer | null, canary: boolean, nowMs: number): { coefficient: number; policyId: string } {
  const learned = learnedValue(prepared, job, pool.id, consumer, canary);
  const shadow = consumer === 'cloud-agent' ? prepared.config.grokUltraWeekly.cloudShadowPrice : 0;
  const roleFit = (role === 'review' || role === 'merge' || role === 'orchestration') && consumer === 'orchestrator' ? 0.05 : 0;
  const bonus = prepared.config.loseItWeight * loseItUrgency(pool, nowMs);
  return {
    coefficient: round6(learned.value - pool.monetaryCost - pool.preferencePenalty - shadow + roleFit + bonus),
    policyId: learned.policyId,
  };
}

function quotaRoom(pool: RuntimePool): number | null {
  if (pool.unlimited) return null;
  if (pool.remaining === null) return Math.max(0, pool.softCapPerDay - pool.usedToday);
  return Math.max(0, pool.remaining);
}

function prepare(input: ScheduleInput): Prepared {
  const config = input.config
    ? applyOverrides(input.config, input.overrides)
    : applyOverrides(embeddedSchedulerConfig(), input.overrides);
  const host = input.host ?? { diskFreeGb: null, batteryPercent: null };
  const built = buildRuntimePools({
    config,
    events: input.events ?? [],
    nowMs: input.nowMs,
    ...(input.inFlight ? { inFlight: input.inFlight } : {}),
  });
  const timeLeft = Math.max(0, built.ultra.resetAtMs - input.nowMs);
  const pace = timeLeft === 0 ? 1 : Math.min(1, config.paceTickMs / timeLeft);
  const reserve = config.grokUltraWeekly.orchestrationReserveFraction * built.ultra.remaining;
  const cloudBudget = Math.max(0, built.ultra.remaining - reserve);
  const totalPace = config.grokUltraWeekly.extraUsageCredits ? Number.POSITIVE_INFINITY : built.ultra.remaining * pace;
  const cloudPace = Math.min(cloudBudget, cloudBudget * pace);
  return {
    config,
    jobs: input.jobs,
    pools: built.pools,
    ultra: built.ultra,
    host,
    bandit: input.bandit ?? emptyBandit(),
    ...(input.candidate ? { candidate: input.candidate } : {}),
    meteredEnabled: input.meteredEnabled === true,
    devinEnabled: input.devinEnabled === true,
    seed: input.seed ?? 1,
    inFlight: input.inFlight ?? {},
    ...(input.valueOverride ? { valueOverride: input.valueOverride } : {}),
    totalPace,
    cloudPace,
  };
}

function pairsFor(prepared: Prepared, job: SchedulerJob, nowMs: number): ScoredPair[] {
  const role = roleOf(job);
  const minTier = tierOf(job, role);
  const canary = canaryBucket(job.id, String(prepared.seed)) < prepared.config.canaryPercent;
  const scored: ScoredPair[] = [];
  for (const pool of prepared.pools) {
    for (const consumer of consumersOf(pool.id)) {
      if (!allowed(role, minTier, pool, consumer, prepared, nowMs)) continue;
      const demand = demandOf(job, pool, prepared.config);
      const room = quotaRoom(pool);
      if (room !== null && demand > room + 1e-9) continue;
      if (consumer === 'cloud-agent' && demand > prepared.cloudPace + 1e-9) continue;
      if (pool.id === 'grok-ultra-weekly' && demand > prepared.totalPace + 1e-9) continue;
      const scoredCoefficient = coefficient(prepared, job, role, pool, consumer, canary, nowMs);
      scored.push({
        pool,
        consumer,
        coefficient: scoredCoefficient.coefficient,
        demand,
        canary,
        policyId: scoredCoefficient.policyId,
      });
    }
  }
  return scored;
}

function lpName(index: number, poolId: string, consumer: UltraConsumer | null): string {
  const consumerName = consumer === null ? 'none' : consumer.replace('-', '_');
  return `x_${index}_${poolId.replace(/[^a-z0-9]+/gi, '_')}_${consumerName}`;
}

function buildModel(prepared: Prepared, nowMs: number): { lp: string; variables: Variable[] } {
  const variables: Variable[] = [];
  const lines: string[] = ['Maximize'];
  const terms: string[] = [];
  prepared.jobs.forEach((job, index) => {
    const pairs = pairsFor(prepared, job, nowMs);
    for (const pair of pairs) {
      if (pair.coefficient <= 0) continue;
      const name = lpName(index, pair.pool.id, pair.consumer);
      variables.push({
        name,
        jobIndex: index,
        poolId: pair.pool.id,
        consumer: pair.consumer,
        coefficient: pair.coefficient,
        demand: pair.demand,
      });
      terms.push(`${pair.coefficient.toFixed(6)} ${name}`);
    }
  });
  lines.push(terms.length === 0 ? ' obj: 0' : ` obj: ${terms.join(' + ')}`);
  lines.push('Subject To');
  let constraints = 0;
  prepared.jobs.forEach((job, index) => {
    const names = variables.filter((variable) => variable.jobIndex === index).map((variable) => variable.name);
    if (job.requireAssignment && names.length === 0) {
      lines.push(` force_${index}: d_${index} = 1`);
      constraints += 1;
      return;
    }
    if (names.length === 0) return;
    const sense = job.requireAssignment ? '=' : '<=';
    lines.push(` job_${index}: ${names.join(' + ')} ${sense} 1`);
    constraints += 1;
  });
  const byPool = new Map<string, Variable[]>();
  for (const variable of variables) {
    const list = byPool.get(variable.poolId) ?? [];
    list.push(variable);
    byPool.set(variable.poolId, list);
  }
  for (const pool of prepared.pools) {
    const list = byPool.get(pool.id) ?? [];
    if (list.length === 0) continue;
    const cap = pool.concurrency - (prepared.inFlight[pool.id] ?? 0);
    lines.push(` cap_${pool.id.replace(/[^a-z0-9]+/gi, '_')}: ${list.map((variable) => variable.name).join(' + ')} <= ${cap.toFixed(6)}`);
    constraints += 1;
    if (pool.id !== 'grok-ultra-weekly') {
      const room = quotaRoom(pool);
      if (room !== null) {
        lines.push(` quota_${pool.id.replace(/[^a-z0-9]+/gi, '_')}: ${list.map((variable) => `${variable.demand.toFixed(6)} ${variable.name}`).join(' + ')} <= ${room.toFixed(6)}`);
        constraints += 1;
      }
    }
  }
  const ultraVars = variables.filter((variable) => variable.poolId === 'grok-ultra-weekly');
  if (ultraVars.length > 0) {
    lines.push(` pace_ultra: ${ultraVars.map((variable) => `${variable.demand.toFixed(6)} ${variable.name}`).join(' + ')} <= ${prepared.totalPace.toFixed(6)}`);
    const cloudVars = ultraVars.filter((variable) => variable.consumer === 'cloud-agent');
    if (cloudVars.length > 0) {
      lines.push(` pace_cloud: ${cloudVars.map((variable) => `${variable.demand.toFixed(6)} ${variable.name}`).join(' + ')} <= ${prepared.cloudPace.toFixed(6)}`);
    }
    constraints += 1;
  }
  if (constraints === 0) lines.push(' noop: 0 <= 1');
  lines.push('Bounds');
  for (const variable of variables) lines.push(` 0 <= ${variable.name} <= 1`);
  prepared.jobs.forEach((job, index) => {
    if (job.requireAssignment && variables.every((variable) => variable.jobIndex !== index)) {
      lines.push(` 0 <= d_${index} <= 0`);
    }
  });
  const generals = [
    ...variables.map((variable) => variable.name),
    ...prepared.jobs.flatMap((job, index) => (
      job.requireAssignment && variables.every((variable) => variable.jobIndex !== index) ? [`d_${index}`] : []
    )),
  ];
  if (generals.length > 0) {
    lines.push('Generals');
    lines.push(` ${generals.join(' ')}`);
  }
  lines.push('End');
  return { lp: `${lines.join('\n')}\n`, variables };
}

function spendOf(pool: RuntimePool): SpendPool {
  const billing = pool.billing === 'loopback' || pool.billing === 'local' ? 'local' : pool.billing === 'subscription' ? 'subscription' : 'metered';
  return {
    id: pool.id,
    billing,
    balance: pool.unlimited ? 1_000_000 : pool.remaining,
    expiresAt: pool.expiresAtMs === null ? null : new Date(pool.expiresAtMs).toISOString(),
    usedToday: pool.usedToday,
    softCapPerDay: pool.unlimited ? 1_000_000 : pool.softCapPerDay,
    tier: pool.tier,
    headroomPercent: pool.headroomPercent,
    meteredOptIn: true,
  };
}

function greedyAssign(prepared: Prepared, nowMs: number): Map<number, Variable> {
  const ranked = rankSpendPools(prepared.pools.map(spendOf), { nowMs, floor: 'local', meteredEnabled: true });
  const chosen = new Map<number, Variable>();
  const usedDemand = new Map<string, number>();
  const usedCount = new Map<string, number>();
  let ultraTotal = 0;
  let ultraCloud = 0;
  prepared.jobs.forEach((job, index) => {
    const pairs = pairsFor(prepared, job, nowMs);
    for (const pool of ranked) {
      const options = pairs.filter((pair) => pair.pool.id === pool.id && pair.coefficient > 0);
      for (const pair of options) {
        const count = (usedCount.get(pool.id) ?? 0) + (prepared.inFlight[pool.id] ?? 0);
        if (count + 1 > pair.pool.concurrency) continue;
        const room = quotaRoom(pair.pool);
        const used = usedDemand.get(pool.id) ?? 0;
        if (room !== null && used + pair.demand > room + 1e-9) continue;
        if (pool.id === 'grok-ultra-weekly' && ultraTotal + pair.demand > prepared.totalPace + 1e-9) continue;
        if (pair.consumer === 'cloud-agent' && ultraCloud + pair.demand > prepared.cloudPace + 1e-9) continue;
        const name = lpName(index, pair.pool.id, pair.consumer);
        chosen.set(index, {
          name,
          jobIndex: index,
          poolId: pair.pool.id,
          consumer: pair.consumer,
          coefficient: pair.coefficient,
          demand: pair.demand,
        });
        usedCount.set(pool.id, (usedCount.get(pool.id) ?? 0) + 1);
        usedDemand.set(pool.id, used + pair.demand);
        if (pool.id === 'grok-ultra-weekly') ultraTotal += pair.demand;
        if (pair.consumer === 'cloud-agent') ultraCloud += pair.demand;
        return;
      }
    }
  });
  return chosen;
}

function decisionsFrom(
  prepared: Prepared,
  nowMs: number,
  chosen: Map<number, Variable>,
  solver: 'highs' | 'greedy',
  fallback: boolean,
): { assignments: Assignment[]; unassigned: string[]; decisions: RouterDecision[]; objective: number } {
  const assignments: Assignment[] = [];
  const unassigned: string[] = [];
  const decisions: RouterDecision[] = [];
  let objective = 0;
  prepared.jobs.forEach((job, index) => {
    const pairs = pairsFor(prepared, job, nowMs);
    const eligible: EligibleRef[] = pairs.map((pair) => ({ poolId: pair.pool.id, consumer: pair.consumer }));
    const pick = chosen.get(index);
    const canary = pairs[0]?.canary ?? canaryBucket(job.id, String(prepared.seed)) < prepared.config.canaryPercent;
    const policyId = pick ? (pairs.find((pair) => pair.pool.id === pick.poolId && pair.consumer === pick.consumer)?.policyId ?? prepared.bandit.id) : prepared.bandit.id;
    if (!pick) {
      unassigned.push(job.id);
      decisions.push(decision(job, null, canary, policyId, solver, fallback, eligible, nowMs));
      return;
    }
    objective += pick.coefficient;
    const pool = prepared.pools.find((item) => item.id === pick.poolId);
    const assignment: Assignment = {
      jobId: job.id,
      poolId: pick.poolId,
      consumer: pick.consumer,
      netValue: pick.coefficient,
      monetaryCost: pool?.monetaryCost ?? 0,
      grantsMergeAuthority: false,
    };
    assignments.push(assignment);
    decisions.push(decision(job, assignment, canary, policyId, solver, fallback, eligible, nowMs));
  });
  return { assignments, unassigned, decisions, objective: round6(objective) };
}

function decision(
  job: SchedulerJob,
  assignment: Assignment | null,
  canary: boolean,
  policyId: string,
  solver: 'highs' | 'greedy',
  fallback: boolean,
  eligible: readonly EligibleRef[],
  nowMs: number,
): RouterDecision {
  return {
    ts: new Date(nowMs).toISOString(),
    jobId: job.id,
    jobType: job.jobType,
    poolId: assignment?.poolId ?? null,
    consumer: assignment?.consumer ?? null,
    policyId,
    canary,
    propensity: 1,
    solver,
    fallback,
    grantsMergeAuthority: false,
    netValue: assignment?.netValue ?? null,
    eligible,
  };
}

function runwayHours(prepared: Prepared, assignments: readonly Assignment[], nowMs: number): number {
  const timeLeft = Math.max(0, prepared.ultra.resetAtMs - nowMs);
  const hoursLeft = timeLeft / 3_600_000;
  const spent = assignments
    .filter((assignment) => assignment.poolId === 'grok-ultra-weekly')
    .reduce((sum, assignment) => {
      const job = prepared.jobs.find((item) => item.id === assignment.jobId);
      const pool = prepared.pools.find((item) => item.id === 'grok-ultra-weekly');
      if (!job || !pool) return sum;
      return sum + demandOf(job, pool, prepared.config);
    }, 0);
  if (spent <= 1e-12) return hoursLeft;
  const paceHours = prepared.config.paceTickMs / 3_600_000;
  return Math.max(0, ((prepared.ultra.remaining - spent) / spent) * paceHours);
}

function resultFrom(
  prepared: Prepared,
  nowMs: number,
  status: ScheduleResult['status'],
  solver: 'highs' | 'greedy',
  fallbackReason: ScheduleResult['fallbackReason'],
  chosen: Map<number, Variable>,
  objective: number | null,
): ScheduleResult {
  const built = decisionsFrom(prepared, nowMs, chosen, solver, fallbackReason !== null);
  return {
    status,
    solver,
    fallbackReason,
    assignments: built.assignments,
    unassigned: built.unassigned,
    decisions: built.decisions,
    ultra: prepared.ultra,
    objective: objective ?? built.objective,
    runwayHours: runwayHours(prepared, built.assignments, nowMs),
  };
}

function chosenFromSolution(variables: readonly Variable[], outcome: SolverOutcome): Map<number, Variable> {
  const chosen = new Map<number, Variable>();
  for (const variable of variables) {
    const primal = outcome.values[variable.name] ?? 0;
    if (primal < 0.5) continue;
    const current = chosen.get(variable.jobIndex);
    if (!current || variable.coefficient > current.coefficient) chosen.set(variable.jobIndex, variable);
  }
  return chosen;
}

/** Pure given its inputs, including the solver and the seed. */
export async function schedule(input: ScheduleInput): Promise<ScheduleResult> {
  const prepared = prepare(input);
  const model = buildModel(prepared, input.nowMs);
  const solver = input.solver ?? highsSolver;
  if (model.variables.length === 0 && !input.jobs.some((job) => job.requireAssignment)) {
    return resultFrom(prepared, input.nowMs, 'optimal', 'highs', null, new Map(), 0);
  }
  let outcome: SolverOutcome;
  try {
    outcome = await solver(model.lp, prepared.config.solverBudgetMs);
  } catch {
    outcome = { status: 'failed', objective: null, values: {} };
  }
  if (outcome.status === 'infeasible') {
    return resultFrom(prepared, input.nowMs, 'infeasible', 'highs', null, new Map(), null);
  }
  if (outcome.status === 'optimal') {
    return resultFrom(prepared, input.nowMs, 'optimal', 'highs', null, chosenFromSolution(model.variables, outcome), outcome.objective);
  }
  const reason = outcome.status === 'timeout' ? 'timeout' : 'failed';
  return resultFrom(prepared, input.nowMs, 'fallback', 'greedy', reason, greedyAssign(prepared, input.nowMs), null);
}
