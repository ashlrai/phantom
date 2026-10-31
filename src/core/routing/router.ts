/** Pure account routing: eligibility and task fit precede ranking. Unknown
 * quality is neutral; provider/model display tiers do not establish capability.
 * Ranking uses explicit operator preference, admitted headroom and independent
 * funding category. Legacy aggregate latency remains diagnostic-only. */
import { paceCeilingAt } from '../resources/pacing.js';
import { opportunityPriority } from './reset-pressure.js';
import type { AccountSchedulingView } from './scheduling-types.js';
import { assessSeat, HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from './headroom.js';
import { CLAUDE_API_SEAT_ID, effectiveSeatPolicy, taskArmKey, taskArmsFor } from './policy.js';
import { listSeatIds, reasonSentences } from './seat-reasons.js';
import { COST_BASIS_RANK, costBasisOf, engineTier, RESOURCE_TIERS, type ResourceTier } from './tiers.js';
import type {
  BudgetMode,
  BudgetPolicy,
  RoutingDifficulty,
  RoutingRequest,
  SeatDecision,
  SeatExclusion,
  SeatHeadroom,
  SeatReason,
  TaskArm,
} from './types.js';

/** A request may use at most this share of a seat's context window. */
export const ROUTER_CONTEXT_FIT_FRACTION = 0.8;

export interface RouteOptions {
  nowMs: number;
  readingMaxAgeMs?: number;
  /** The λ objective weights; absent uses the existing harness baseline. */
  weights?: Partial<RouterWeights>;
  /**
   * Legacy seat/aggregate latency, retained for compatible callers. Without
   * exact account/model/task/version provenance it does not steer ranking.
   */
  latencyMs?: Readonly<Record<string, number>>;
  /** Deliberately supplied operator preference, never inferred catalog tiers.
   * Invocation-only: historical capacity.tier is display metadata. */
  explicitTiers?: Readonly<Record<string, ResourceTier>>;
  /** Actual selected-task opportunity; eligibility/quality remain mandatory. */
  scheduling?: Readonly<Record<string,AccountSchedulingView>>;
  advisorySeatId?: string | null;
  /**
   * Task-arm outcome evidence, keyed by arm key (`taskArmKey`): merged green
   * PRs and measured tokens for the reward, plus the arm's spend inside its
   * current pacing window. Consulted only while `policy.taskArms` is enabled;
   * malformed reward entries read as unmeasured, and malformed pace evidence
   * fails closed (the arm stays inadmissible).
   */
  armStats?: Readonly<Record<string, TaskArmObservation>>;
}

/** Measured outcome and pacing evidence for one task arm (`RouteOptions.armStats`). */
export interface TaskArmObservation {
  /** Merged green PRs attributed to this arm on completed work. */
  mergedPrs?: number;
  /** Total measured input+output tokens on that completed work. */
  tokens?: number;
  /** The arm's spend inside its current pacing window. */
  pace?: {
    /** Epoch ms the current window started. */
    windowStartMs: number;
    /** Tokens spent so far in that window. */
    spentTokens: number;
  };
}

/** Independent funding-category and headroom weights. lambdaLatency remains
 * readable for old harness configurations but unqualified aggregate latency
 * cannot affect the operational rank. These weights authorize no spending. */
export interface RouterWeights {
  lambdaCost: number;
  lambdaPressure: number;
  lambdaLatency: number;
}

/** Existing harness baseline; coefficients are preserved. */
export const DEFAULT_ROUTER_WEIGHTS: Readonly<RouterWeights> = Object.freeze({
  lambdaCost: 1,
  lambdaPressure: 1,
  lambdaLatency: 0.25,
});


/** Best tier first — interactive work and hard autonomous work. */
const QUALITY_FIRST: readonly ResourceTier[] = RESOURCE_TIERS;
/** Cheapest rung first — the cost ladder (free → fast → elite). */
const CHEAP_FIRST: readonly ResourceTier[] = [...RESOURCE_TIERS].reverse();

/** A seat's tier: what its capacity says (per model), else its engine's. */
export function capacityTier(capacity: Pick<SeatCapacity, 'engine' | 'tier'>): ResourceTier {
  return capacity.tier ?? engineTier(capacity.engine);
}

/** Legacy display helper. This inferred rung is not an operational quality,
 * price or funding proof, and default account ranking does not consume it. */
export function costRung(capacity: Pick<SeatCapacity, 'engine' | 'tier' | 'costBasis' | 'free'>): ResourceTier {
  if (capacity.free || (capacity.costBasis ?? costBasisOf(capacity.engine)) === 'free') return 'free';
  return capacityTier(capacity);
}


/** Legacy mode order, used only when a caller explicitly supplies tier
 * preferences. Catalog tier metadata alone does not request that preference. */
export interface RankOrder {
  /** Historical preference axis, preserved for compatible callers. */
  by: 'tier' | 'cost';
  order: readonly ResourceTier[];
}

/** Historical tier preference table for an explicitly requested preference;
 * unknown default quality stays neutral regardless of request difficulty. */
export function tierPreference(mode: BudgetMode, req: RoutingRequest): RankOrder {
  const quality: RankOrder = { by: 'tier', order: QUALITY_FIRST };
  const cheap: RankOrder = { by: 'cost', order: CHEAP_FIRST };
  if (!req.autonomous) return quality;
  const difficulty: RoutingDifficulty = req.task === 'leader' && req.difficulty !== 'high' ? 'high' : req.difficulty;
  if (req.task === 'bulk' || difficulty === 'low') return cheap;
  if (mode === 'reserve') {
    // Free first for everything but genuinely hard work, and even that only
    // reaches the small paid slice the reserve-mode ceilings leave.
    return difficulty === 'high' ? { by: 'tier', order: ['fast', 'elite', 'free'] } : cheap;
  }
  if (difficulty === 'medium') {
    return mode === 'all-in'
      ? { by: 'tier', order: ['fast', 'elite', 'free'] }
      : { by: 'cost', order: ['fast', 'free', 'elite'] };
  }
  return quality;
}

interface Verdict {
  capacity: SeatCapacity;
  /** Position in the caller's list — discovery order, which ranks the operator's preferred local tags first. */
  index: number;
  headroom: SeatHeadroom | null;
  eligible: boolean;
  /** The blockers as data; `SeatExclusion.reasons` is derived from them. */
  details: SeatReason[];
  nextEligibleAt: string | null;
  /** The task arm this seat would serve, set only while the arm flag steers. */
  arm?: { arm: TaskArm; reward: number | null };
}

function interactiveVerdict(capacity: SeatCapacity, nowMs: number, readingMaxAgeMs: number): Verdict {
  const details: SeatReason[] = [];
  let nextEligibleAt: string | null = null;
  if (capacity.signedOut) details.push({ kind: 'signed-out', text: 'Signed out — reconnect this account.' });
  if (capacity.reachable === false && !capacity.signedOut) details.push({ kind: 'unreachable', text: 'Not reachable right now.' });
  // Reuse the autonomy assessment only for the facts it establishes about
  // the ACCOUNT (spent windows and their resets) — never its reserves.
  const facts = assessSeat(capacity, { seatId: capacity.seatId, enabled: true, reservePercent: 0 }, {
    nowMs,
    readingMaxAgeMs,
  });
  if (facts.exhausted) {
    details.push(...facts.spentDetails);
    nextEligibleAt = facts.reopensAt;
  }
  return { capacity, index: 0, headroom: facts.headroom, eligible: details.length === 0, details, nextEligibleAt };
}

function autonomousVerdict(capacity: SeatCapacity, policy: BudgetPolicy, nowMs: number, readingMaxAgeMs: number): Verdict {
  const seatPolicy = effectiveSeatPolicy(policy, capacity.seatId, capacity.engine);
  const assessed = assessSeat(capacity, seatPolicy, { nowMs, readingMaxAgeMs });
  return {
    capacity,
    index: 0,
    headroom: assessed.headroom,
    eligible: assessed.headroom.eligibleForAutonomy,
    // Blocked seats report the blockers; the "N% left" line is for eligible ones.
    details: assessed.headroom.eligibleForAutonomy ? [] : assessed.details,
    nextEligibleAt: assessed.headroom.eligibleForAutonomy ? null : assessed.reopensAt,
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function applyFit(verdict: Verdict, contextTokens: number | undefined): Verdict {
  if (contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens <= 0) return verdict;
  const window = verdict.capacity.contextWindow;
  if (window === null) return verdict;
  if (contextTokens <= window * ROUTER_CONTEXT_FIT_FRACTION) return verdict;
  return {
    ...verdict,
    eligible: false,
    details: [...verdict.details, {
      kind: 'context',
      text: `Needs about ${formatTokens(contextTokens)} tokens of context; this seat's window is `
        + `${formatTokens(window)} (at most ${Math.round(ROUTER_CONTEXT_FIT_FRACTION * 100)}% is used for a task).`,
    }],
    // A window does not grow back on a schedule.
    nextEligibleAt: null,
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Existing headroom coefficient; preserved independently of quality. */
const PRESSURE_SCALE = 0.5;

/** The headroom a windowless seat is ranked with: the middle of the range. */
const WINDOWLESS_HEADROOM = 50;

/** Scores closer than this are a tie (they fall through to caller order, then id). */
const SCORE_EPSILON = 1e-9;

/**
 * The largest λ the router honours — the harness registry's own bound
 * (HARNESS_CONFIG_BOUNDS.lambdaMax; a test pins the two together, restated so
 * this browser-safe module does not import the harness). A larger value is
 * clamped here, so every score stays finite: an unbounded λ could overflow to
 * Infinity, and Infinity − Infinity = NaN would make the comparator
 * inconsistent (the sort order would then depend on the engine's algorithm).
 */
export const ROUTER_LAMBDA_MAX = 10;

function resolveWeights(weights: Partial<RouterWeights> | undefined): RouterWeights {
  // A malformed λ (NaN, ±Infinity, negative, not a number) falls back to its
  // default rather than poisoning the ranking; an over-large one is clamped
  // to ROUTER_LAMBDA_MAX (it keeps its direction, bounded).
  const pick = (key: keyof RouterWeights): number => {
    const v = weights?.[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, ROUTER_LAMBDA_MAX) : DEFAULT_ROUTER_WEIGHTS[key];
  };
  return { lambdaCost: pick('lambdaCost'), lambdaPressure: pick('lambdaPressure'), lambdaLatency: pick('lambdaLatency') };
}

function isDefaultWeights(w: RouterWeights): boolean {
  return w.lambdaCost === DEFAULT_ROUTER_WEIGHTS.lambdaCost
    && w.lambdaPressure === DEFAULT_ROUTER_WEIGHTS.lambdaPressure
    && w.lambdaLatency === DEFAULT_ROUTER_WEIGHTS.lambdaLatency;
}

/** Lower is preferred. Neither unknown quality nor a provider label adds a
 * score. Cost is a funding category, not a dollar estimate or admission proof. */
function seatScore(v: Verdict, position: number, w: RouterWeights): number {
  const left = v.headroom?.autonomyHeadroomPercent ?? (v.capacity.windowless ? WINDOWLESS_HEADROOM : -1);
  return position
    + w.lambdaPressure * PRESSURE_SCALE * (100 - left) / 101
    + w.lambdaCost * MARGINAL_COST_SCALE * marginalCost(v.capacity);
}

/** Existing funding-category coefficient, worth about 20 headroom points
 * at baseline. This is not a dollar estimate or native billing admission. */
const MARGINAL_COST_SCALE = 0.1;

function marginalCost(capacity: SeatCapacity): number {
  // A missing category is neutral, not a fabricated USD0/free resource.
  // Current projections may supply coarse subscription categories; execution
  // still requires its independent native billing/account proof.
  const basis = capacity.free ? 'free' : capacity.costBasis;
  return basis === undefined ? 0.5 : COST_BASIS_RANK[basis];
}

/** Rank already eligible rows. Explicit preference may separate groups; legacy
 * inferred tiers cannot prevent a comparable resource using its allowance. */
function rank(verdicts: Verdict[], rankOrder: RankOrder, w: RouterWeights, options?: RouteOptions): Verdict[] {
  const position = (capacity: SeatCapacity): number => {
    const tiers = options?.explicitTiers;
    const tier = tiers && Object.hasOwn(tiers, capacity.seatId) ? tiers[capacity.seatId] : undefined;
    const index = tier === undefined ? -1 : rankOrder.order.indexOf(tier);
    return index === -1 ? 0 : index - 1;
  };
  const score = new Map(verdicts.map((v) => [v, seatScore(v, position(v.capacity), w)]));
  const ranked = [...verdicts].sort((a, b) => {
    const diff = score.get(a)! - score.get(b)!;
    if (Math.abs(diff) > SCORE_EPSILON) return diff;
    if (a.index !== b.index) return a.index - b.index;
    return compareIds(a.capacity.seatId, b.capacity.seatId);
  });
  if (!options?.scheduling) return ranked;
  // Preserve explicitly preferred groups. Within a group, reset opportunities
  // may reorder only already admitted resources, as before.
  const baselineIndex = new Map(ranked.map((v,i)=>[v,i]));
  const groups = new Map<number, number[]>();
  ranked.forEach((v,i) => { const key = position(v.capacity); const indexes = groups.get(key) ?? []; indexes.push(i); groups.set(key,indexes); });
  for (const indexes of groups.values()) {
    const ordered = indexes.map((i) => ranked[i]!).sort((a,b) => {
      const av = options.scheduling![a.capacity.seatId]; const bv = options.scheduling![b.capacity.seatId];
      const ap = av ? opportunityPriority(av, options.nowMs) : 0; const bp = bv ? opportunityPriority(bv, options.nowMs) : 0;
      if (ap !== bp) return bp-ap;
      if (options.advisorySeatId) {
        const advice = Number(b.capacity.seatId === options.advisorySeatId)-Number(a.capacity.seatId === options.advisorySeatId);
        if (advice) return advice;
      }
      if (ap > 0 && av?.reset.at && bv?.reset.at) {
        const earlier = Date.parse(av.reset.at)-Date.parse(bv.reset.at);
        if (earlier) return earlier;
      }
      return baselineIndex.get(a)!-baselineIndex.get(b)!;
    });
    indexes.forEach((index,i) => { ranked[index] = ordered[i]!; });
  }
  return ranked;
}

// ---------------------------------------------------------------------------
// Task-aware arms (flagged; `policy.taskArms.enabled`)
// ---------------------------------------------------------------------------

/** The lead an arm may run ahead of its ideal pace line by default (5% of budget). */
export const TASK_ARM_PACE_LEAD = 0.05;

/** Observation for an arm, honouring own-name keys only. */
function armObservation(
  stats: Readonly<Record<string, TaskArmObservation>> | undefined,
  arm: TaskArm,
): TaskArmObservation | undefined {
  const key = taskArmKey(arm);
  return stats && Object.hasOwn(stats, key) ? stats[key] : undefined;
}

/** Merged green PRs per token; null when the arm has no measured yield. */
function armReward(arm: TaskArm, stats: Readonly<Record<string, TaskArmObservation>> | undefined): number | null {
  const obs = armObservation(stats, arm);
  const merged = typeof obs?.mergedPrs === 'number' && Number.isFinite(obs.mergedPrs) && obs.mergedPrs >= 0
    ? obs.mergedPrs : null;
  const tokens = typeof obs?.tokens === 'number' && Number.isFinite(obs.tokens) && obs.tokens > 0
    ? obs.tokens : null;
  return merged !== null && tokens !== null ? merged / tokens : null;
}

/**
 * Whether an arm may take one more job under its token pacing budget: its
 * observed window spend must not be ahead of the pace ceiling (the linear LP
 * pacing constraint; a job may cross the line by its own size). No pace spec
 * or no evidence yet is admissible; corrupt evidence fails closed.
 */
function armPaceVerdict(
  arm: TaskArm,
  obs: TaskArmObservation | undefined,
  nowMs: number,
): { ok: true } | { ok: false; reopensAt: string | null } {
  const pace = arm.pace;
  const evidence = obs?.pace;
  if (!pace || evidence === undefined) return { ok: true };
  if (typeof evidence !== 'object' || evidence === null) return { ok: false, reopensAt: null };
  const { windowStartMs, spentTokens } = evidence;
  if (!Number.isSafeInteger(windowStartMs) || windowStartMs > nowMs
      || !Number.isFinite(spentTokens) || spentTokens < 0) {
    return { ok: false, reopensAt: null };
  }
  const resetAtMs = windowStartMs + pace.windowMs;
  if (nowMs >= resetAtMs) return { ok: true };
  const spentFraction = spentTokens / pace.budgetTokens;
  const lead = pace.leadFraction ?? TASK_ARM_PACE_LEAD;
  const ceiling = paceCeilingAt({ nowMs, resetAtMs, windowStartMs, leadFraction: lead });
  if (spentFraction <= ceiling) return { ok: true };
  if (spentFraction > 1) return { ok: false, reopensAt: new Date(resetAtMs).toISOString() };
  // Earliest instant the pace line (including the lead) reaches the spend.
  const catchUpMs = windowStartMs + Math.max(0, spentFraction - lead) * pace.windowMs;
  return { ok: false, reopensAt: new Date(Math.max(nowMs, catchUpMs)).toISOString() };
}

/**
 * The task-arm stage. For an autonomous request on an armed class, a seat
 * stays a candidate only while one of the class's arms runs on its engine
 * inside its pacing budget; each surviving verdict remembers its best arm
 * and measured yield for the reward rank. Arms that fail `isTaskArm`
 * (an unknown engine, a bad effort or a malformed pace spec) never match a
 * seat, and a class with no valid arm leaves every verdict untouched, so the
 * flag off is byte-identical to today.
 */
function applyTaskArms(
  verdicts: Verdict[],
  policy: BudgetPolicy,
  req: RoutingRequest,
  opts: RouteOptions,
): boolean {
  if (!req.autonomous || policy.taskArms?.enabled !== true) return false;
  const arms = taskArmsFor(policy.taskArms, req.task);
  if (arms.length === 0) return false;
  const byEngine = new Map<string, TaskArm[]>();
  for (const arm of arms) {
    const list = byEngine.get(arm.engine) ?? [];
    list.push(arm);
    byEngine.set(arm.engine, list);
  }
  for (const v of verdicts) {
    if (!v.eligible) continue;
    const matching = byEngine.get(v.capacity.engine) ?? [];
    if (matching.length === 0) {
      v.eligible = false;
      v.details.push({
        kind: 'task-arm',
        text: `No task arm for ${req.task} work runs on the ${v.capacity.engine} engine.`,
      });
      v.nextEligibleAt = null;
      continue;
    }
    let best: { arm: TaskArm; reward: number | null } | null = null;
    let earliestReopen: string | null = null;
    for (const arm of matching) {
      const paced = armPaceVerdict(arm, armObservation(opts.armStats, arm), opts.nowMs);
      if (!paced.ok) {
        if (paced.reopensAt !== null && (earliestReopen === null || paced.reopensAt < earliestReopen)) {
          earliestReopen = paced.reopensAt;
        }
        continue;
      }
      const reward = armReward(arm, opts.armStats);
      if (best === null || (reward ?? 0) > (best.reward ?? 0)) best = { arm, reward };
    }
    if (best === null) {
      v.eligible = false;
      v.details.push({
        kind: 'task-arm',
        text: `This seat's ${req.task} task arms cannot prove they are inside their token pacing budgets.`,
        ...(earliestReopen !== null ? { resetsAt: earliestReopen } : {}),
      });
      v.nextEligibleAt = earliestReopen;
      continue;
    }
    v.arm = best;
  }
  return true;
}

/** Measured yield first, the baseline order as the tiebreak. Only runs while the flag steers. */
function orderByArmReward(ranked: Verdict[]): void {
  const baseline = new Map(ranked.map((v, i) => [v, i]));
  ranked.sort((a, b) => {
    const diff = (b.arm?.reward ?? 0) - (a.arm?.reward ?? 0);
    if (Math.abs(diff) > SCORE_EPSILON) return diff;
    return baseline.get(a)! - baseline.get(b)!;
  });
}

function formatWeight(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function formatArmRate(reward: number): string {
  return String(Math.round(reward * 1e9) / 1e9);
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function describeWork(req: RoutingRequest): string {
  return `${req.difficulty}-difficulty ${req.task} work`;
}

function routeVerdicts(req: RoutingRequest, capacity: readonly SeatCapacity[], policy: BudgetPolicy,
  opts: RouteOptions): Verdict[] {
  const readingMaxAgeMs = opts.readingMaxAgeMs ?? HEADROOM_READING_MAX_AGE_MS;
  const verdicts = capacity.map((seat, index): Verdict => ({
    ...(seat.engine === 'claude-api' || seat.seatId.toLowerCase() === CLAUDE_API_SEAT_ID
      ? { capacity: seat, eligible: false, headroom: null, nextEligibleAt: null,
        details: [{ kind: 'grant' as const, text: 'Claude API is not commissioned in the signed grant.' }] }
      : req.autonomous && seat.engine === 'devin' && !(seat.seatId === 'devin-cli' && seat.free === true && seat.costBasis === 'free')
      ? devinFleetVerdict(seat)
      : applyFit(
        req.autonomous
          ? autonomousVerdict(seat, policy, opts.nowMs, readingMaxAgeMs)
          : interactiveVerdict(seat, opts.nowMs, readingMaxAgeMs),
        req.contextTokens,
      )),
    index,
  }));

  if (req.autonomous && opts.scheduling) {
    for (const v of verdicts) {
      const advisory = opts.scheduling[v.capacity.seatId];
      if (v.eligible && advisory?.admission === 'unknown') {
        v.eligible = false;
        v.details.push({kind:'unknown-usage',text:'Current account-window evidence is incomplete or has passed its reported period.'});
      }
    }
  }
  return verdicts;
}

/** Compare exact model variants which the caller already admitted. Returned
 * objects retain identity; no virtual seat IDs or new execution permission. */
export function rankEligibleCapacities(req: RoutingRequest, capacities: readonly SeatCapacity[], policy: BudgetPolicy,
  opts: RouteOptions): SeatCapacity[] {
  const verdicts = routeVerdicts(req, capacities, policy, opts);
  const armsActive = applyTaskArms(verdicts, policy, req, opts);
  const eligible = rank(verdicts.filter(v => v.eligible), tierPreference(policy.mode, req), resolveWeights(opts.weights), opts);
  if (armsActive) orderByArmReward(eligible);
  return eligible.map(v => v.capacity);
}

/**
 * "codex-cmp: autonomy is switched off for this seat" — the FIRST reason, as
 * text without its reset clause, so a list of these never nests parentheses.
 */
export function describeExclusion(exclusion: SeatExclusion): string {
  const first = exclusion.details?.[0]?.text ?? exclusion.reasons[0] ?? 'not eligible';
  return `${exclusion.seatId}: ${lowerFirst(first).replace(/\.$/, '')}`;
}

/** Up to `max` exclusions described, then "and N more" — never a bare "…". */
export function describeExclusions(exclusions: readonly SeatExclusion[], max = 3): string {
  const shown = exclusions.slice(0, max).map(describeExclusion).join('; ');
  return exclusions.length > max ? `${shown}; and ${exclusions.length - max} more` : shown;
}

/** Cloud ACU sessions retain their separately accounted launch lane. The native
 * devin-cli adapter may route included models only when its caller supplies
 * current host-issued pricing evidence as free capacity; a company label does
 * not exclude a qualified native role. This pure router never mints evidence. */
function devinFleetVerdict(capacity: SeatCapacity): Verdict {
  const details: SeatReason[] = [{
    kind: 'lane',
    text: 'The fleet runs Devin as its own session lane under the Devin budget, not through the seat router.',
  }];
  return { capacity, index: 0, headroom: null, eligible: false, details, nextEligibleAt: null };
}

/**
 * Decide which seat `req` should use. Pure. Every seat in `capacity` ends up
 * in exactly one of `candidates` or `exclusions`.
 */
export function routeSeat(
  req: RoutingRequest,
  capacity: readonly SeatCapacity[],
  policy: BudgetPolicy,
  opts: RouteOptions,
): SeatDecision {
  const verdicts = routeVerdicts(req, capacity, policy, opts);
  const armsActive = applyTaskArms(verdicts, policy, req, opts);
  const order = tierPreference(policy.mode, req);
  const weights = resolveWeights(opts.weights);
  const eligible = rank(verdicts.filter((v) => v.eligible), order, weights, opts);
  if (armsActive) orderByArmReward(eligible);
  const exclusions: SeatExclusion[] = verdicts
    .filter((v) => !v.eligible)
    .map((v) => ({
      seatId: v.capacity.seatId,
      reasons: reasonSentences(v.details),
      nextEligibleAt: v.nextEligibleAt,
      details: v.details,
    }))
    .sort((a, b) => compareIds(a.seatId, b.seatId));

  const chosen = eligible[0] ?? null;
  const candidates = eligible.map((v) => v.capacity.seatId);
  const who = req.autonomous ? 'autonomous ' : '';

  // `why` is the full sentence the logs and the CLI print; `summary` is the
  // short headline a UI shows above its own per-seat list. Neither repeats
  // the per-seat reasons — `exclusions` carries those as data.
  let why: string;
  let summary: string;
  if (chosen) {
    const preference = opts.explicitTiers && Object.hasOwn(opts.explicitTiers, chosen.capacity.seatId) ? opts.explicitTiers[chosen.capacity.seatId] : undefined;
    const rankReason = preference ? `the explicit ${preference} preference, admitted headroom and funding category` : 'admitted headroom and funding category; quality and comparable latency are unmeasured';
    const room = chosen.headroom?.autonomyHeadroomPercent;
    const windowWord = chosen.headroom?.bindingWindow === 'session' ? '5-hour' : 'weekly';
    const hasRoom = req.autonomous && !chosen.capacity.free && typeof room === 'number';
    const roomText = hasRoom
      ? ` with ${room}% of its ${windowWord} window left for autonomy`
      : chosen.capacity.free ? ' with no provider token charge' : '';
    const held = exclusions.length === 0 ? ''
      : `; held back ${exclusions.length === 1 ? '1 seat' : `${exclusions.length} seats`} (${listSeatIds(exclusions.map((e) => e.seatId))})`;
    // Tuned weights can put a seat ahead of the mode's own order, so the
    // sentence names them; at the defaults it stays byte-identical.
    const tuned = isDefaultWeights(weights) ? ''
      : `; routing weights cost ×${formatWeight(weights.lambdaCost)}, headroom ×${formatWeight(weights.lambdaPressure)}, `
        + `retained latency weight ×${formatWeight(weights.lambdaLatency)} is inactive`;
    const armText = chosen.arm
      ? `; task arm ${taskArmKey(chosen.arm.arm)}${chosen.arm.reward !== null
        ? ` at ${formatArmRate(chosen.arm.reward)} merged PRs/token` : ' with no measured merged-PR yield'}`
      : '';
    why = `Routed ${who}${describeWork(req)} to ${chosen.capacity.label} (${chosen.capacity.seatId})${roomText}: `
      + `${policy.mode} mode ranks by ${rankReason}${tuned}${held}${armText}.`;
    const lead = hasRoom
      ? ` — ${room}% of its ${windowWord} window left`
      : chosen.capacity.free ? ' — no provider token charge, no usage window' : '';
    summary = lead
      ? `${chosen.capacity.label}${lead}; ${policy.mode} mode ranks by ${rankReason}${armText}.`
      : `${chosen.capacity.label} — ${policy.mode} mode ranks by ${rankReason}${armText}.`;
  } else if (capacity.length === 0) {
    why = `No seats are known, so ${who}${describeWork(req)} has nowhere to run.`;
    summary = 'No seats are known, so this work has nowhere to run.';
  } else {
    const reopen = exclusions.flatMap((e) => (e.nextEligibleAt ? [e.nextEligibleAt] : []))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
    why = `No seat can take ${who}${describeWork(req)} in ${policy.mode} mode (${describeExclusions(exclusions)})`
      + `${reopen ? `; the earliest known reopening is ${reopen}` : ''}.`;
    summary = `No seat can take this ${describeWork(req)} in ${policy.mode} mode right now.`;
  }

  return {
    seatId: chosen?.capacity.seatId ?? null,
    ...(chosen?.arm
      ? {
        taskArm: {
          key: taskArmKey(chosen.arm.arm),
          engine: chosen.arm.arm.engine,
          model: chosen.arm.arm.model,
          effort: chosen.arm.arm.effort,
          rewardPerToken: chosen.arm.reward,
        },
      }
      : {}),
    candidates,
    exclusions,
    why,
    summary,
    mode: policy.mode,
  };
}

/**
 * Ranked seats Mason could use INSTEAD of `blockedSeatId` for his own work
 * right now (reserves do not apply to him). For the readiness gate's
 * `SeatReadiness.alternatives`.
 */
export function rankAlternatives(
  blockedSeatId: string,
  capacity: readonly SeatCapacity[],
  policy: BudgetPolicy,
  opts: RouteOptions,
): string[] {
  const blocked = capacity.find((c) => c.seatId === blockedSeatId);
  const decision = routeSeat(
    { task: 'code', difficulty: 'medium', autonomous: false },
    capacity.filter((c) => c.seatId !== blockedSeatId),
    policy,
    opts,
  );
  if (!blocked) return decision.candidates;
  // Same engine first (a second account of the same provider is the least
  // surprising substitute), then the router's own order.
  const sameEngine = new Set(capacity.filter((c) => c.engine === blocked.engine).map((c) => c.seatId));
  return [
    ...decision.candidates.filter((id) => sameEngine.has(id)),
    ...decision.candidates.filter((id) => !sameEngine.has(id)),
  ];
}
