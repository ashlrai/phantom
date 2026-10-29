/**
 * job-ev-route.ts - per-job pool/tier/model choice by expected value (EV).
 *
 * The Ashlr router queue (queue.v1) asks for one routing answer per job:
 * which pool may spend on it, under which tier label, with which serving
 * model. This module answers with the arm offering the best EXPECTED MERGED
 * IMPACT PER TOKEN - the same objective `metrics/scoring.ts` calls
 * `valuePerMTok` and the router metrics feed calls `mergedImpactPerToken`
 * (merged impact credited through the shared phantom-impact score, divided
 * by every token the arm burned, including failed and empty jobs).
 *
 * Guards above the EV ranking, in order:
 *  1. Mechanical templates (rebase, docs, formatting, lint, rename) route to
 *     the local oMLX pool only. A mechanical job is NEVER upgraded to paid
 *     spend silently: when the local pool cannot admit it, the answer is a
 *     hold with reasons, not a frontier bill.
 *  2. Hard or high-impact jobs (Tier-1 risk, high difficulty, hard keywords,
 *     or a high expected impact) route to frontier arms only. Local and mid
 *     arms are excluded, never merely deprioritised.
 *  3. Budget pressure: an arm is ineligible while its pool is over pace,
 *     paused, held or reports zero remaining capacity. Pressure comes from
 *     the `phm budget plan` document (schema `fleet.budget-plan.v1`), or is
 *     derived from the `phm budget show` snapshot (`fleet.budgets.v1`) when
 *     no plan is supplied. Unknown pressure is neutral, never zero.
 *
 * Priors: per-(lane,tier), per-template, per-tier, per-lane and overall
 * rollups shaped like the router metrics feed (mergeRate,
 * emptyJobRate, tokensPerMergedPR, mergedImpactPerToken, completedJobs;
 * `phm metrics` rollups name the same EV field valuePerMTok). The
 * most specific group with at least MIN_PRIOR_JOBS completed jobs wins;
 * sparser groups fall through to broader ones. A measured
 * `mergedImpactPerToken` is used verbatim. When only merge and token
 * measurements exist the EV is derived: E[impact|merged] /
 * tokensPerMergedPR (failed and empty jobs already sit in that denominator,
 * so merge rate is not applied twice). With no usable group at all the
 * cold-start table orders the arms; it is an ordering prior, never a
 * measurement.
 *
 * PURE: no I/O, no clock reads, no provider calls, no dispatch authority.
 * The decision is advisory data for the queue's trusted router.
 */

import { BUDGET_POOLS, type BudgetPool } from './pool-budget.js';
import {
  DEFAULT_CLAUDE_MODEL_ID,
  DEFAULT_CODEX_MODEL_ID,
  DEFAULT_LOCAL_MODEL_TAG,
  GROK_CLI_DEFAULT_MODEL,
  GROK_CLI_FAST_MODEL,
} from '../run/model-catalog.js';

// ---------------------------------------------------------------------------
// Arms: the (pool, tier, model) choices the queue router may make.
// ---------------------------------------------------------------------------

export const ROUTE_TIERS = ['local', 'mid', 'frontier'] as const;
export type RouteTier = (typeof ROUTE_TIERS)[number];

export interface RouteArm {
  readonly pool: BudgetPool;
  readonly tier: RouteTier;
  /** The pool's serving default model. A serving label, not a measurement. */
  readonly model: string;
}

/**
 * Cheapest-first order. Every budget pool has exactly one arm: the tier it is
 * chartered for and its serving default model. A tie on EV resolves to the
 * earlier arm, so cheap capacity wins when measurements cannot separate them.
 */
export const ROUTE_ARMS: readonly RouteArm[] = Object.freeze([
  { pool: 'local-omlx', tier: 'local', model: DEFAULT_LOCAL_MODEL_TAG },
  { pool: 'grok-build', tier: 'mid', model: GROK_CLI_FAST_MODEL },
  { pool: 'codex-cmp', tier: 'frontier', model: DEFAULT_CODEX_MODEL_ID },
  { pool: 'codex-personal', tier: 'frontier', model: DEFAULT_CODEX_MODEL_ID },
  { pool: 'claude', tier: 'frontier', model: DEFAULT_CLAUDE_MODEL_ID },
  { pool: 'devin', tier: 'frontier', model: 'devin' },
  { pool: 'grok-ultra', tier: 'frontier', model: GROK_CLI_DEFAULT_MODEL },
]);

// ---------------------------------------------------------------------------
// Job spec and template classification
// ---------------------------------------------------------------------------

export const JOB_TEMPLATES = ['mechanical', 'standard', 'hard'] as const;
export type JobTemplate = (typeof JOB_TEMPLATES)[number];

/** The job the queue asks about. Unknown queue fields are ignored. */
export interface RouteJobSpec {
  readonly id: string;
  readonly repo?: string;
  /** Untrusted task text, classified by keyword only. Never echoed back. */
  readonly task?: string;
  /** Explicit template label; aliases below map it, unknown means standard. */
  readonly template?: string;
  /** 1 = Tier-1 paths (CODEOWNERS Tier-1); forces the frontier guard. */
  readonly riskTier?: 1 | 2 | 3;
  readonly difficulty?: 'low' | 'medium' | 'high';
  /** Expected impact of a merged result, in phantom-impact/v1 units. */
  readonly expectedImpact?: number;
}

/** Expected merged impact this high counts as high-impact: frontier guard. */
export const HARD_IMPACT_THRESHOLD = 40;

const TEMPLATE_ALIASES: Readonly<Record<string, JobTemplate>> = {
  mechanical: 'mechanical', rebase: 'mechanical', 'merge-conflict': 'mechanical',
  docs: 'mechanical', doc: 'mechanical', documentation: 'mechanical',
  format: 'mechanical', formatting: 'mechanical', lint: 'mechanical',
  typo: 'mechanical', rename: 'mechanical', comment: 'mechanical',
  readme: 'mechanical', changelog: 'mechanical',
  standard: 'standard', feature: 'standard', fix: 'standard', bugfix: 'standard',
  refactor: 'standard', test: 'standard', perf: 'standard',
  hard: 'hard', security: 'hard', auth: 'hard', migration: 'hard',
  redesign: 'hard', 'tier-1': 'hard', tier1: 'hard', critical: 'hard',
};

const MECHANICAL_TASK = /(rebase|merge[- ]?conflicts?|format(?:ting)?|prettier|lint|typo|rename|whitespace|comment|docs?|readme|changelog|markdown|license header|copyright|sort imports?|bump (deps|version))/i;
const HARD_TASK = /(security|auth|credential|crypto|secret|migration|architect|redesign|consensus|billing|payment|release|production|data loss|tier-?1|rce|injection|xss)/i;

/**
 * The template the EV guards route under. Explicit labels win; then declared
 * hard signals (Tier-1 risk, high difficulty, high expected impact); then
 * task keywords - hard before mechanical, so auth-adjacent text never lands
 * on a 27B local model; then the standard default.
 */
export function classifyJobTemplate(spec: RouteJobSpec): JobTemplate {
  const explicit = spec.template?.trim().toLowerCase();
  if (explicit && Object.hasOwn(TEMPLATE_ALIASES, explicit)) return TEMPLATE_ALIASES[explicit]!;
  if (spec.riskTier === 1 || spec.difficulty === 'high') return 'hard';
  if (spec.expectedImpact !== undefined && spec.expectedImpact >= HARD_IMPACT_THRESHOLD) return 'hard';
  const task = spec.task ?? '';
  if (explicit) {
    // An unknown explicit label still scans the task text for hard signals.
    if (HARD_TASK.test(task)) return 'hard';
    return 'standard';
  }
  if (HARD_TASK.test(task)) return 'hard';
  if (MECHANICAL_TASK.test(task)) return 'mechanical';
  return 'standard';
}

/** Tier labels each template may spend on. */
const TEMPLATE_TIERS: Readonly<Record<JobTemplate, readonly RouteTier[]>> = {
  mechanical: ['local'],
  standard: ROUTE_TIERS,
  hard: ['frontier'],
};

// ---------------------------------------------------------------------------
// Priors: per-template and per-tier metrics from the router metrics feed
// ---------------------------------------------------------------------------

export interface RoutePrior {
  readonly mergeRate: number | null;
  readonly emptyJobRate: number | null;
  readonly tokensPerMergedPR: number | null;
  readonly mergedImpactPerToken: number | null;
  readonly completedJobs: number;
}

/**
 * Priors keyed like the router metrics feed: `lanes` by pool id, `tiers` by
 * tier label, `laneTiers` by `${pool}/${tier}`, `templates` by template label
 * (a forward extension - the feed does not group by template yet), plus an
 * `overall` fallback.
 */
export interface RoutePriors {
  readonly lanes?: Readonly<Record<string, RoutePrior>>;
  readonly tiers?: Readonly<Record<string, RoutePrior>>;
  readonly laneTiers?: Readonly<Record<string, RoutePrior>>;
  readonly templates?: Readonly<Record<string, RoutePrior>>;
  readonly overall?: RoutePrior;
}

/** A group must have this many completed jobs before its prior steers an arm. */
export const MIN_PRIOR_JOBS = 3;

/**
 * Cold-start EV ordering on the shared impact-per-token scale. These are
 * source-owned ordering guesses - never measurements - used only while no
 * feed group has enough completions to speak.
 */
export const COLD_START_EV: Readonly<Record<JobTemplate, Readonly<Record<RouteTier, number>>>> = Object.freeze({
  mechanical: Object.freeze({ local: 1, mid: 0.3, frontier: 0.1 }),
  standard: Object.freeze({ local: 0.5, mid: 1, frontier: 0.6 }),
  hard: Object.freeze({ local: 0.05, mid: 0.4, frontier: 1 }),
});

/**
 * Expected merged impact per template in phantom-impact/v1 units: mechanical
 * merges are small, hard merges are the bold work the score rewards. Used for
 * the derived EV only; a job's own expectedImpact wins when supplied.
 */
export const TEMPLATE_EXPECTED_IMPACT: Readonly<Record<JobTemplate, number>> = Object.freeze({
  mechanical: 3,
  standard: 10,
  hard: 30,
});

function rate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
function quantity(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function priorOf(value: unknown): RoutePrior | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const completedJobs = quantity(row['completedJobs']);
  if (completedJobs === null || !Number.isInteger(completedJobs)) return null;
  const valuePerMTok = quantity(row['valuePerMTok']);
  return {
    mergeRate: rate(row['mergeRate']),
    emptyJobRate: rate(row['emptyJobRate']),
    tokensPerMergedPR: quantity(row['tokensPerMergedPR']),
    // The feed names it mergedImpactPerToken; `phm metrics` rollups name the
    // same quantity valuePerMTok (per million tokens). Both are accepted.
    mergedImpactPerToken: quantity(row['mergedImpactPerToken'])
      ?? (valuePerMTok !== null ? valuePerMTok / 1e6 : null),
    completedJobs,
  };
}
function priorMap(value: unknown): Record<string, RoutePrior> {
  const out: Record<string, RoutePrior> = {};
  if (!Array.isArray(value)) {
    // Also accept an already-keyed object map.
    if (value && typeof value === 'object') {
      for (const [key, row] of Object.entries(value)) {
        const prior = priorOf(row);
        if (prior) out[key] = prior;
      }
    }
    return out;
  }
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const key = typeof row['key'] === 'string' ? row['key']
      : typeof row['lane'] === 'string' && typeof row['tier'] === 'string' ? `${row['lane']}/${row['tier']}`
      : null;
    const prior = key && priorOf(entry);
    if (key && prior) out[key] = prior;
  }
  return out;
}

/**
 * Build priors from a `phm metrics ingest` feed (kind 'router-metrics') or
 * from an already-keyed RoutePriors object. Anything unparseable degrades to
 * fewer priors; it never throws and never invents a measurement.
 */
export function routePriorsFromMetrics(value: unknown): RoutePriors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const feed = value as Record<string, unknown>;
  return {
    lanes: priorMap(feed['lanes']),
    tiers: priorMap(feed['tiers']),
    laneTiers: priorMap(feed['laneTiers']),
    templates: priorMap(feed['templates']),
    overall: priorOf(feed['overall']) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Budget pressure: from `phm budget plan`, else derived from the snapshot
// ---------------------------------------------------------------------------

export type PoolPressureState = 'open' | 'over-pace' | 'paused' | 'held' | 'closed' | 'unknown';

export interface PoolPressure {
  readonly state: PoolPressureState;
  readonly concurrency?: string;
  readonly lane?: string;
  readonly paceRatio?: number | null;
  readonly maxConcurrency?: number | null;
  readonly reason: string;
}

/** plan.tolerance default, matching the pacing plan's on-pace band. */
export const PRESSURE_PACE_TOLERANCE = 0.1;

function planPressure(decision: Record<string, unknown>, pool: BudgetPool, tolerance: number): PoolPressure {
  const concurrency = typeof decision['concurrency'] === 'string' ? decision['concurrency'] : 'hold';
  const lane = typeof decision['lane'] === 'string' ? decision['lane'] : 'none';
  const paceRatio = quantity(decision['paceRatio']);
  const maxConcurrency = quantity(decision['maxConcurrency']);
  const reasons = Array.isArray(decision['reasons'])
    ? decision['reasons'].filter((r): r is string => typeof r === 'string')
    : [];
  const reason = reasons.join(' ') || `No plan reason recorded for ${pool}.`;
  if (concurrency === 'pause') return { state: 'paused', concurrency, lane, paceRatio, maxConcurrency, reason };
  if (lane === 'held') return { state: 'held', concurrency, lane, paceRatio, maxConcurrency, reason };
  if (lane === 'none' || lane === '') return { state: 'closed', concurrency, lane, paceRatio, maxConcurrency, reason };
  if (maxConcurrency === 0) {
    return { state: 'closed', concurrency, lane, paceRatio, maxConcurrency, reason: `${pool} has no free capacity under the plan.` };
  }
  if (concurrency === 'lower' || (paceRatio !== null && paceRatio > 1 + tolerance)) {
    return { state: 'over-pace', concurrency, lane, paceRatio, maxConcurrency, reason };
  }
  return { state: 'open', concurrency, lane, paceRatio, maxConcurrency, reason };
}

/**
 * Pressure per pool from a `phm budget plan` document - accepts the CLI's
 * `{plan: ...}` wrapper or the bare plan. Pools missing from the decisions
 * map are 'unknown', never silently open.
 */
export function poolPressureFromPlan(value: unknown): Record<BudgetPool, PoolPressure> {
  const wrapper = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const plan = wrapper['plan'] && typeof wrapper['plan'] === 'object' && !Array.isArray(wrapper['plan'])
    ? wrapper['plan'] as Record<string, unknown>
    : wrapper;
  if (plan['schema'] !== undefined && plan['schema'] !== 'fleet.budget-plan.v1') {
    throw new RouteInputError('Expected a fleet.budget-plan.v1 document (phm budget plan output).');
  }
  const decisions = plan['decisions'] && typeof plan['decisions'] === 'object' && !Array.isArray(plan['decisions'])
    ? plan['decisions'] as Record<string, unknown>
    : {};
  const tolerance = quantity(plan['tolerance']) ?? PRESSURE_PACE_TOLERANCE;
  const out = {} as Record<BudgetPool, PoolPressure>;
  for (const pool of BUDGET_POOLS) {
    const decision = decisions[pool];
    out[pool] = decision && typeof decision === 'object' && !Array.isArray(decision)
      ? planPressure(decision as Record<string, unknown>, pool, tolerance)
      : { state: 'unknown', reason: 'No plan decision recorded for this pool.' };
  }
  return out;
}

interface SnapshotBucket {
  remaining?: number | null;
  resetAt?: string | null;
  state?: string;
  projectedExhaustion?: string | null;
}

interface SpendLane {
  lane: string;
  remaining: number | null;
  resetAt: string | null;
  state: string;
  projectedExhaustion: string | null;
}

function laneOf(lane: string, b: SnapshotBucket): SpendLane {
  return {
    lane,
    remaining: b.remaining ?? null,
    resetAt: b.resetAt ?? null,
    state: b.state ?? 'unknown',
    projectedExhaustion: b.projectedExhaustion ?? null,
  };
}

/** The spend lane a metered pool would charge: expiring window, then credits. */
function snapshotLane(buckets: Record<string, SnapshotBucket | undefined> | undefined): SpendLane {
  const weekly = buckets?.['weeklyPct'];
  if (weekly) {
    if (weekly.state === 'observed' && weekly.remaining != null && weekly.remaining > 0) {
      return laneOf('weekly', weekly);
    }
    if (weekly.state === 'observed' && weekly.remaining === 0) {
      const credits = buckets?.['credits'];
      if (credits?.state === 'observed' && credits.remaining != null && credits.remaining > 0) {
        return laneOf('credits', credits);
      }
      return { ...laneOf('none', weekly), remaining: 0 };
    }
    return laneOf('none', weekly);
  }
  const acus = buckets?.['acus'];
  if (acus) return laneOf('metered', acus);
  return { lane: 'none', remaining: null, resetAt: null, state: 'unknown', projectedExhaustion: null };
}

/**
 * The minimal pressure read derivable from a `phm budget show` snapshot when
 * no plan document is supplied. A snapshot has no pace target, so 'over-pace'
 * is only inferred when the ledger's own exhaustion projection is already at
 * or behind the snapshot timestamp; otherwise the honest answers are
 * exhausted/reset-pending (paused), held, closed and unknown.
 */
export function poolPressureFromSnapshot(value: unknown): Record<BudgetPool, PoolPressure> {
  const wrapper = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const snapshot = wrapper['budgets'] && typeof wrapper['budgets'] === 'object' && !Array.isArray(wrapper['budgets'])
    ? wrapper['budgets'] as Record<string, unknown>
    : wrapper;
  if (snapshot['schema'] !== undefined && snapshot['schema'] !== 'fleet.budgets.v1') {
    throw new RouteInputError('Expected a fleet.budgets.v1 snapshot (phm budget show output).');
  }
  const pools = snapshot['pools'] && typeof snapshot['pools'] === 'object' && !Array.isArray(snapshot['pools'])
    ? snapshot['pools'] as Record<string, unknown>
    : {};
  const unavailable = snapshot['sourceState'] !== undefined && snapshot['sourceState'] !== 'healthy';
  const asOf = typeof snapshot['timestamp'] === 'string' && Number.isFinite(Date.parse(snapshot['timestamp']))
    ? Date.parse(snapshot['timestamp'])
    : null;
  const out = {} as Record<BudgetPool, PoolPressure>;
  for (const pool of BUDGET_POOLS) {
    const view = pools[pool];
    if (!view || typeof view !== 'object' || Array.isArray(view)) {
      out[pool] = { state: 'unknown', reason: 'No budget reading recorded for this pool.' };
      continue;
    }
    if (unavailable) {
      out[pool] = { state: 'unknown', reason: 'The budget ledger is unavailable; pressure is unknown.' };
      continue;
    }
    const row = view as { mode?: unknown; buckets?: Record<string, SnapshotBucket | undefined> };
    if (row.mode === 'held') {
      out[pool] = { state: 'held', lane: 'held', reason: 'Pool is held; it spends nothing.' };
      continue;
    }
    if (row.mode === 'capacity-only') {
      const capacity = row.buckets?.['capacity'];
      const slots = capacity?.remaining !== null && capacity?.remaining !== undefined ? Math.max(0, Math.floor(capacity.remaining)) : null;
      out[pool] = slots === 0
        ? { state: 'paused', lane: 'capacity', maxConcurrency: 0, reason: 'Observed capacity is zero.' }
        : { state: 'open', lane: 'capacity', maxConcurrency: slots, reason: 'Capacity pool admits while slots remain.' };
      continue;
    }
    const lane = snapshotLane(row.buckets);
    if (lane.lane === 'none') {
      out[pool] = lane.remaining === 0
        ? { state: 'paused', lane: 'none', reason: 'Observed spend lane is exhausted.' }
        : lane.state === 'reset-pending'
          ? { state: 'paused', lane: 'none', reason: 'Reset already passed; hold until a fresh reading lands.' }
          : { state: 'unknown', lane: 'none', reason: 'No spend lane is observed for this pool.' };
      continue;
    }
    if (lane.remaining !== null && lane.remaining <= 0) {
      out[pool] = { state: 'paused', lane: lane.lane, reason: 'Observed spend lane is exhausted.' };
      continue;
    }
    // The ledger only records a projection when the lane runs dry before its
    // reset, so any set projection already means future exhaustion. Flagging
    // over-pace on that alone would exclude every pool that is spending at
    // all; only a projection at or behind the snapshot timestamp is a
    // reliable over-pace read without the plan's pace target.
    const alreadyDry = asOf !== null && lane.projectedExhaustion !== null
      && Date.parse(lane.projectedExhaustion) <= asOf;
    out[pool] = alreadyDry
      ? { state: 'over-pace', lane: lane.lane, reason: 'Ledger projects the lane dry already.' }
      : { state: 'open', lane: lane.lane, reason: 'Spend lane is open.' };
  }
  return out;
}

/** Whether a pool may take new work under its pressure reading. */
export function poolAdmits(pressure: PoolPressure | undefined): { admit: boolean; reason: string | null } {
  if (!pressure || pressure.state === 'unknown') return { admit: true, reason: null };
  switch (pressure.state) {
    case 'open': return { admit: true, reason: null };
    case 'over-pace': return { admit: false, reason: `over pace: ${pressure.reason}` };
    case 'paused': return { admit: false, reason: `paused: ${pressure.reason}` };
    case 'held': return { admit: false, reason: `held: ${pressure.reason}` };
    case 'closed': return { admit: false, reason: `closed: ${pressure.reason}` };
  }
}

// ---------------------------------------------------------------------------
// The routing decision
// ---------------------------------------------------------------------------

export interface RouteExclusion {
  readonly pool: BudgetPool;
  readonly tier: RouteTier;
  readonly model: string;
  readonly reason: string;
}

export interface JobRouteDecision {
  readonly schemaVersion: 1;
  readonly kind: 'job-route';
  readonly job: string;
  readonly repo: string | null;
  readonly template: JobTemplate;
  readonly action: 'route' | 'hold';
  readonly pool: BudgetPool | null;
  readonly tier: RouteTier | null;
  readonly model: string | null;
  /** Expected merged impact per token for the chosen arm; null on hold. */
  readonly expectedImpactPerToken: number | null;
  /** Which prior produced the EV (or 'cold-start'). */
  readonly priorBasis: string | null;
  /** Measured tokens per merged PR behind the EV; null when unmeasured. */
  readonly expectedTokensPerMergedPR: number | null;
  readonly reasons: readonly string[];
  readonly excluded: readonly RouteExclusion[];
}

interface PriorHit {
  value: number;
  basis: string;
  tokensPerMergedPR: number | null;
  prior: RoutePrior | null;
}

function expectedImpactOf(spec: RouteJobSpec, template: JobTemplate): number {
  return spec.expectedImpact !== undefined ? spec.expectedImpact : TEMPLATE_EXPECTED_IMPACT[template];
}

function evFromPrior(prior: RoutePrior, impact: number, basis: string): PriorHit | null {
  if (prior.mergedImpactPerToken !== null) {
    return { value: prior.mergedImpactPerToken, basis, tokensPerMergedPR: prior.tokensPerMergedPR, prior };
  }
  if (prior.mergeRate !== null && prior.tokensPerMergedPR !== null && prior.tokensPerMergedPR > 0) {
    // tokensPerMergedPR divides every completed job's tokens by merges, so
    // failed and empty jobs are already paid for in the denominator. The
    // merge rate itself must not be applied a second time.
    return { value: prior.mergeRate === 0 ? 0 : impact / prior.tokensPerMergedPR, basis, tokensPerMergedPR: prior.tokensPerMergedPR, prior };
  }
  return null;
}

function armExpectedValue(arm: RouteArm, template: JobTemplate, spec: RouteJobSpec, priors: RoutePriors, minJobs: number): PriorHit {
  const impact = expectedImpactOf(spec, template);
  const lookups: Array<[string, RoutePrior | undefined]> = [
    [`laneTier ${arm.pool}/${arm.tier}`, priors.laneTiers?.[`${arm.pool}/${arm.tier}`]],
    [`template ${template}`, priors.templates?.[template]],
    [`tier ${arm.tier}`, priors.tiers?.[arm.tier]],
    [`lane ${arm.pool}`, priors.lanes?.[arm.pool]],
    ['overall', priors.overall],
  ];
  for (const [basis, prior] of lookups) {
    if (!prior || prior.completedJobs < minJobs) continue;
    const hit = evFromPrior(prior, impact, basis);
    if (hit) return hit;
  }
  return { value: COLD_START_EV[template][arm.tier], basis: 'cold-start', tokensPerMergedPR: null, prior: null };
}

/**
 * Choose the (pool, tier, model) arm with the best expected merged impact
 * per token that budget pressure admits. Never throws on well-typed input.
 */
export function routeJobExpectedValue(
  spec: RouteJobSpec,
  options: { priors?: RoutePriors; pressure?: Partial<Record<BudgetPool, PoolPressure>>; minPriorJobs?: number } = {},
): JobRouteDecision {
  const template = classifyJobTemplate(spec);
  const priors = options.priors ?? {};
  const pressure = options.pressure ?? {};
  const minJobs = options.minPriorJobs ?? MIN_PRIOR_JOBS;
  const tiers = TEMPLATE_TIERS[template];
  const excluded: RouteExclusion[] = [];
  const ranked: Array<{ arm: RouteArm; hit: PriorHit }> = [];

  for (const arm of ROUTE_ARMS) {
    if (!tiers.includes(arm.tier)) {
      excluded.push({ pool: arm.pool, tier: arm.tier, model: arm.model,
        reason: template === 'mechanical'
          ? 'mechanical work stays on the local pool; paid tiers are not consulted'
          : 'hard work stays on frontier tiers; this arm is below the frontier bar' });
      continue;
    }
    const admission = poolAdmits(pressure[arm.pool]);
    if (!admission.admit) {
      excluded.push({ pool: arm.pool, tier: arm.tier, model: arm.model, reason: admission.reason! });
      continue;
    }
    ranked.push({ arm, hit: armExpectedValue(arm, template, spec, priors, minJobs) });
  }

  // Cold-start numbers and measured impact-per-token are different scales.
  // Once any arm carries a measured or derived EV, an arm with no evidence
  // scores 0 rather than outranking real data on a guess. Only when nothing
  // is measured at all does the cold-start table order the arms.
  const anyMeasured = ranked.some((entry) => entry.hit.basis !== 'cold-start');
  const scored = ranked.map((entry) => ({
    ...entry,
    value: entry.hit.basis === 'cold-start' && anyMeasured ? 0 : entry.hit.value,
  }));
  scored.sort((a, b) => {
    if (a.value !== b.value) return b.value - a.value;
    const at = a.hit.tokensPerMergedPR ?? Number.MAX_SAFE_INTEGER;
    const bt = b.hit.tokensPerMergedPR ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return ROUTE_ARMS.indexOf(a.arm) - ROUTE_ARMS.indexOf(b.arm);
  });

  const base = {
    schemaVersion: 1 as const, kind: 'job-route' as const,
    job: spec.id, repo: spec.repo ?? null, template, excluded,
  };
  const guard = template === 'mechanical'
    ? 'Mechanical template: only the local oMLX pool is eligible.'
    : template === 'hard'
      ? 'Hard or high-impact job: only frontier arms are eligible.'
      : 'Standard job: every tier competes on expected merged impact per token.';
  const winner = scored[0];
  if (!winner) {
    return {
      ...base, action: 'hold', pool: null, tier: null, model: null,
      expectedImpactPerToken: null, priorBasis: null, expectedTokensPerMergedPR: null,
      reasons: [guard, 'No eligible arm admits this job; holding rather than spending outside the budget or tier guards.'],
    };
  }
  const prior = winner.hit.prior;
  const measured = prior
    ? `merge rate ${prior.mergeRate ?? 'unknown'}, empty rate ${prior.emptyJobRate ?? 'unknown'}, tokens/merge ${prior.tokensPerMergedPR ?? 'unknown'} over ${prior.completedJobs} completed jobs`
    : 'no measured prior at minimum sample size';
  return {
    ...base,
    action: 'route',
    pool: winner.arm.pool,
    tier: winner.arm.tier,
    model: winner.arm.model,
    expectedImpactPerToken: Math.round(winner.value * 1e6) / 1e6,
    priorBasis: winner.hit.basis,
    expectedTokensPerMergedPR: winner.hit.tokensPerMergedPR,
    reasons: [
      guard,
      `Best expected merged impact per token among admitted arms (${winner.hit.basis}: ${measured}).`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Job input validation (queue text is untrusted data)
// ---------------------------------------------------------------------------

/** Controlled parse failure; the CLI prints this without echoing input. */
export class RouteInputError extends Error {}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const MAX_TASK_CHARS = 8_000;

/** Validate one queue job spec. Unknown fields are ignored, never retained. */
export function parseRouteJobSpec(value: unknown): RouteJobSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteInputError('Job input must be a JSON object.');
  }
  const row = value as Record<string, unknown>;
  if (typeof row['id'] !== 'string' || !JOB_ID.test(row['id'])) {
    throw new RouteInputError('Job id must be an identifier (letters, digits, ._:@+- up to 128 chars).');
  }
  const spec: { id: string; repo?: string; task?: string; template?: string; riskTier?: 1 | 2 | 3; difficulty?: 'low' | 'medium' | 'high'; expectedImpact?: number } = { id: row['id'] };
  if (row['repo'] !== undefined) {
    if (typeof row['repo'] !== 'string' || !REPO.test(row['repo'])) throw new RouteInputError('Repo must be owner/name.');
    spec.repo = row['repo'];
  }
  if (row['task'] !== undefined) {
    if (typeof row['task'] !== 'string' || row['task'].length > MAX_TASK_CHARS || row['task'].includes('\u0000')) {
      throw new RouteInputError(`Task text must be a string of at most ${MAX_TASK_CHARS} characters without NUL.`);
    }
    spec.task = row['task'];
  }
  if (row['template'] !== undefined) {
    if (typeof row['template'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row['template'])) {
      throw new RouteInputError('Template must be an identifier of at most 64 chars.');
    }
    spec.template = row['template'];
  }
  if (row['riskTier'] !== undefined) {
    if (![1, 2, 3].includes(row['riskTier'] as number)) throw new RouteInputError('riskTier must be 1, 2 or 3.');
    spec.riskTier = row['riskTier'] as 1 | 2 | 3;
  }
  if (row['difficulty'] !== undefined) {
    if (!['low', 'medium', 'high'].includes(row['difficulty'] as string)) throw new RouteInputError('difficulty must be low, medium or high.');
    spec.difficulty = row['difficulty'] as 'low' | 'medium' | 'high';
  }
  if (row['expectedImpact'] !== undefined) {
    const impact = row['expectedImpact'];
    if (typeof impact !== 'number' || !Number.isFinite(impact) || impact < 0 || impact > 1_000_000) {
      throw new RouteInputError('expectedImpact must be a finite nonnegative number.');
    }
    spec.expectedImpact = impact;
  }
  return spec;
}
