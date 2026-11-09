/**
 * task-bandit.ts — task-aware bandit lane (RQ-PARITYROUTERTASKQ7), extending
 * the #960 local-first bandit design from two lane arms {local, frontier} to
 * (engine, model, effort) task arms inside the EXISTING seat router. There is
 * no second router: `router.ts` narrows capacity to the picked arm's engine
 * and calls the unchanged `routeSeat` core, so every eligibility, headroom,
 * honesty and funding check stays exactly where it was.
 *
 * Pipeline: task classifier (class, size, risk, repo) → context cell →
 * Thompson draw over eligible arms → seat router inside that engine.
 *
 *   - Reward is "merged and green PR per token": a run that produced a merged
 *     PR with green checks earns min(1, tokenNorm / tokens); anything else
 *     earns 0. Beta posteriors make the objective merges-per-token, not
 *     merges alone.
 *   - LP pacing (#938, resources/pacing.ts `paceWindow`) is an eligibility
 *     constraint: an engine pool whose first-period allowance does not clear
 *     the configured floor routes no arm — the bandit can never spend past
 *     the plan. Missing or invalid pacing evidence fails closed.
 *   - Risky classes stay frontier-only per #926: `riskClass === 'high'` or an
 *     authority flag (merge/publish) admits only hosted-engine arms.
 *     Credentialed work holds outright — no model seat holds secrets.
 *   - Unknown engines are never arms and are never selected: the catalog is
 *     the five named engines (Claude Code, Codex, Grok, Devin, oMLX-local);
 *     a seat whose engine matches none of them is invisible to this lane.
 *   - Deterministic: every draw comes from a mulberry32 stream seeded by
 *     FNV-1a(seed, item key), so a replay picks the same arms.
 *   - Flag-off: an absent or disabled flag adds no `bandit` field and changes
 *     no routing. PURE and BROWSER-SAFE: no node: imports, no I/O; the caller
 *     owns persistence and evidence.
 */
import { paceWindow, type HorizonKnobs, type ReadingStamp } from '../resources/pacing.js';
import {
  isFrontierTaskEngine,
  isTaskBanditEngine,
  parseTaskBanditConfig,
  TASK_BANDIT_ENGINES,
  type TaskBanditConfig,
} from './policy.js';
import type {
  RoutingRequest,
  SeatBanditNote,
  TaskArm,
  TaskBanditContext,
  TaskBanditEngine,
  TaskEffort,
  TaskRiskClass,
  TaskSizeBucket,
} from './types.js';

// ---------------------------------------------------------------------------
// Arm catalog — (engine, model, effort) over the five named engines
// ---------------------------------------------------------------------------

const arm = (engine: TaskBanditEngine, model: string | null, effort: TaskEffort): TaskArm =>
  ({ id: `${engine}:${model ?? 'default'}:${effort}`, engine, model, effort });

/**
 * The arm catalog. Model tags name the engine-side default variants the rest
 * of the codebase already knows (Codex terra/sol/astra, Grok 4.7 family,
 * Devin SWE-2, the elite local qwen3.8 build); null means "engine default".
 * Devin's lane seats only ever dispatch through the native devin-cli lane —
 * cloud ACU seats stay refused by the seat router as before.
 */
export const TASK_BANDIT_ARMS: readonly TaskArm[] = Object.freeze([
  arm('claude', 'haiku', 'low'),
  arm('claude', 'sonnet', 'medium'),
  arm('claude', 'opus', 'high'),
  arm('codex', 'gpt-6.1-terra', 'low'),
  arm('codex', 'gpt-6.1-sol', 'medium'),
  arm('codex', 'gpt-6-astra', 'high'),
  arm('grok', 'grok-4.7-build-fast', 'low'),
  arm('grok', 'grok-4.7', 'medium'),
  arm('devin', 'swe-2-medium', 'low'),
  arm('devin', 'swe-2-high', 'medium'),
  arm('devin', 'swe-2-max', 'high'),
  arm('local', null, 'low'),
  arm('local', 'qwen3.8:27b-ctx64k', 'medium'),
]);

export function taskArmById(id: string): TaskArm | null {
  return TASK_BANDIT_ARMS.find((a) => a.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Task classifier — (class, size, risk, repo) → context cell
// ---------------------------------------------------------------------------

export const UNKNOWN_REPO = 'unknown';

/** Optional hints a caller can supply on top of the RoutingRequest. */
export interface TaskContextHints {
  /** Work-item/queue id; keys the deterministic PRNG stream. */
  itemKey?: string;
  /** Lowercase `owner/name`; absent or malformed → 'unknown'. */
  repo?: string;
  /** Explicit risk class; absent derives from `req.difficulty`. */
  riskClass?: TaskRiskClass;
  /** Authority roles per #926: merge, merge-rights and publish are frontier-only. */
  mergesToMain?: boolean;
  holdsMergeRights?: boolean;
  publishes?: boolean;
  /** Credentialed steps hold entirely — no model seat holds secrets. */
  needsCredentials?: boolean;
}

/** True when the context keeps the pick inside the hosted frontier lane. */
export function isRiskyContext(ctx: TaskBanditContext, hints?: TaskContextHints): boolean {
  return ctx.riskClass === 'high'
    || hints?.mergesToMain === true
    || hints?.holdsMergeRights === true
    || hints?.publishes === true;
}

function bucketOf(contextTokens: number | undefined, edges: readonly number[]): TaskSizeBucket {
  const t = typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0;
  const buckets: readonly TaskSizeBucket[] = ['xs', 's', 'm', 'l', 'xl'];
  for (let i = 0; i < edges.length; i += 1) if (t < edges[i]!) return buckets[i]!;
  return buckets[buckets.length - 1]!;
}

function normalizeRepo(raw: unknown): string {
  if (typeof raw !== 'string') return UNKNOWN_REPO;
  const repo = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/.test(repo) ? repo : UNKNOWN_REPO;
}

function riskOf(req: RoutingRequest, hints?: TaskContextHints): TaskRiskClass {
  const raw = hints?.riskClass;
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : req.difficulty;
}

/** Pure. The (class, size, risk, repo) cell the bandit keys on. */
export function classifyTaskContext(req: RoutingRequest, config: TaskBanditConfig, hints?: TaskContextHints): TaskBanditContext {
  return {
    taskClass: req.task,
    sizeBucket: bucketOf(req.contextTokens, config.sizeEdges),
    riskClass: riskOf(req, hints),
    repo: normalizeRepo(hints?.repo),
  };
}

/**
 * Cell keys, most specific first: exact (class·size·risk·repo), repo
 * generalized, size generalized, global. Every outcome lands in all four, so
 * a cold exact cell still has the evidence a coarser level accumulated.
 */
export function contextCellKeys(ctx: TaskBanditContext): string[] {
  return [
    `c=${ctx.taskClass}|s=${ctx.sizeBucket}|r=${ctx.riskClass}|p=${ctx.repo}`,
    `c=${ctx.taskClass}|s=${ctx.sizeBucket}|r=${ctx.riskClass}`,
    `c=${ctx.taskClass}|r=${ctx.riskClass}`,
    'g',
  ];
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (the #960 construction: FNV-1a key, mulberry32 stream)
// ---------------------------------------------------------------------------

export type UniformSource = () => number;

/** Pure. mulberry32 stream keyed on FNV-1a(seed, key). Returns floats in [0, 1). */
export function seededTaskRandom(seed: number, key = ''): UniformSource {
  let h = 0x811c9dc5;
  for (const ch of `${seed}:${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rng: UniformSource): number {
  const u = Math.max(rng(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Marsaglia–Tsang Gamma(shape, 1); shape < 1 uses the α+1 identity. */
function gammaSample(shape: number, rng: UniformSource): number {
  if (shape < 1) {
    return gammaSample(shape + 1, rng) * Math.pow(Math.max(rng(), Number.MIN_VALUE), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = standardNormal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = Math.max(rng(), Number.MIN_VALUE);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** Beta(α, β) in the open interval (0, 1); degenerate masses nudge inside. */
export function betaSample(alpha: number, beta: number, rng: UniformSource): number {
  const x = gammaSample(Math.max(alpha, 1e-9), rng);
  const y = gammaSample(Math.max(beta, 1e-9), rng);
  const total = x + y;
  if (!(total > 0) || !Number.isFinite(total)) return 0.5;
  const value = x / total;
  if (value <= 0) return Number.EPSILON;
  if (value >= 1) return 1 - Number.EPSILON;
  return value;
}

// ---------------------------------------------------------------------------
// Posterior state — Beta per (context cell × arm), four generality levels
// ---------------------------------------------------------------------------

/** Per-cell posterior for one arm: fractional successes `a`, failures `b`, draws `n`. */
export interface ArmPosterior {
  a: number;
  b: number;
  n: number;
}

export interface TaskBanditState {
  readonly v: 1;
  /** context-cell key → arm id → posterior. */
  readonly cells: Readonly<Record<string, Readonly<Record<string, ArmPosterior>>>>;
}

export function emptyTaskBanditState(): TaskBanditState {
  return { v: 1, cells: {} };
}

/**
 * Validate persisted state. Corrupt or foreign shapes fail CLOSED to a fresh
 * prior rather than routing on poisoned posteriors.
 */
export function taskBanditStateFrom(value: unknown): TaskBanditState {
  if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) return emptyTaskBanditState();
  const cells = (value as { cells?: unknown }).cells;
  if (typeof cells !== 'object' || cells === null || Array.isArray(cells)) return emptyTaskBanditState();
  const out: Record<string, Record<string, ArmPosterior>> = {};
  for (const [key, cell] of Object.entries(cells as Record<string, unknown>)) {
    if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) continue;
    const laneCell: Record<string, ArmPosterior> = {};
    for (const [armId, p] of Object.entries(cell as Record<string, ArmPosterior>)) {
      if (typeof p !== 'object' || p === null) continue;
      if (!Number.isFinite(p.a) || !Number.isFinite(p.b) || !Number.isFinite(p.n)) continue;
      if (p.a < 0 || p.b < 0 || p.n < 0) continue;
      laneCell[armId] = { a: p.a, b: p.b, n: p.n };
    }
    if (Object.keys(laneCell).length > 0) out[key] = laneCell;
  }
  return { v: 1, cells: out };
}

function posteriorAt(state: TaskBanditState, cellKey: string, armId: string): ArmPosterior | null {
  const p = state.cells[cellKey]?.[armId];
  return p && Number.isFinite(p.a) && Number.isFinite(p.b)
    ? { a: p.a, b: p.b, n: Number.isFinite(p.n) ? p.n : 0 }
    : null;
}

/**
 * Fold one unit reward into every cell level for the arm that earned it.
 * A fractional update puts `r` mass on α and `1−r` on β.
 */
export function updateTaskBanditState(
  state: TaskBanditState,
  context: TaskBanditContext,
  armId: string,
  reward: number,
): TaskBanditState {
  if (!Number.isFinite(reward)) return state;
  const clipped = Math.min(1, Math.max(0, reward));
  const cells: Record<string, Record<string, ArmPosterior>> = { ...state.cells };
  for (const key of contextCellKeys(context)) {
    const cell = { ...(cells[key] ?? {}) };
    const previous = cell[armId] ?? { a: 0, b: 0, n: 0 };
    cell[armId] = { a: previous.a + clipped, b: previous.b + (1 - clipped), n: previous.n + 1 };
    cells[key] = cell;
  }
  return { v: 1, cells };
}

// ---------------------------------------------------------------------------
// Reward — merged and green PR per token
// ---------------------------------------------------------------------------

export interface TaskReward {
  /** Clipped to [0,1] — what the Beta posterior consumes. */
  unit: number;
  /** Unclipped merges-per-norm-token; >1 reports super-efficient merges. */
  raw: number;
  /** merged === true AND ciGreen === true. */
  success: boolean;
}

export interface TaskOutcome {
  merged?: boolean;
  ciGreen?: boolean;
  /** Total measured input+output tokens; absent or non-positive → the floor. */
  tokens?: number;
}

/**
 * The task's reward made exact. Success means merged AND green; a success
 * earns `tokenNorm / max(tokens, tokenFloor)` clipped to [0,1] — a merged
 * cheap PR scores ~1, a merged expensive one a fraction, and a run that never
 * merged scores 0 whatever it burned. Absent token evidence is the floor
 * (full credit), never a synthesized cost — an absence, not a claim.
 */
export function taskOutcomeReward(outcome: TaskOutcome, config: TaskBanditConfig): TaskReward {
  const success = outcome.merged === true && outcome.ciGreen === true;
  if (!success) return { unit: 0, raw: 0, success: false };
  const tokens = typeof outcome.tokens === 'number' && Number.isFinite(outcome.tokens) && outcome.tokens > 0
    ? outcome.tokens : config.tokenFloor;
  const raw = config.tokenNorm / Math.max(tokens, config.tokenFloor);
  return { unit: Math.min(1, Math.max(0, raw)), raw, success: true };
}

// ---------------------------------------------------------------------------
// LP pacing constraint (#938) — per-engine first-period allowance gate
// ---------------------------------------------------------------------------

/**
 * One engine pool's current pacing evidence. `used` is the fraction of the
 * window already spent (0..1); the window bounds and optional knobs/stamp are
 * exactly `paceWindow`'s own inputs — no second pacing policy lives here.
 */
export interface TaskBanditPacingInput {
  used: number;
  resetAtMs: number;
  windowStartMs: number;
  knobs?: Partial<HorizonKnobs>;
  stamp?: ReadingStamp;
}

/** Default pacing knobs; the caller's own knobs win when supplied. */
export const DEFAULT_TASK_PACING_KNOBS: Readonly<HorizonKnobs> = Object.freeze({
  bufferFraction: 0.1,
  bufferWindowMs: 30 * 60_000,
  reserveFraction: 0,
  flex: 1.5,
  deviationWeight: 0.5,
  flexPenalty: 0.25,
  landingWeight: 0.5,
  periodMs: 15 * 60_000,
  maxPeriods: 48,
});

/**
 * The first-period allowance the #938 pace plan commits for one engine pool
 * right now (a fraction of its window). Null = no admissible plan: absent,
 * malformed or invalid evidence fails CLOSED, matching "unknown usage is not
 * headroom" — the bandit never spends a pool it cannot prove has room.
 */
export function pacingAllowance(
  engine: string,
  pacing: Readonly<Record<string, TaskBanditPacingInput>> | undefined,
  nowMs: number,
): number | null {
  if (pacing === undefined) return Number.POSITIVE_INFINITY;
  const input = Object.hasOwn(pacing, engine) ? pacing[engine] : undefined;
  if (!input) return null;
  try {
    const plan = paceWindow({
      poolId: `task-bandit:${engine}`,
      used: input.used,
      nowMs,
      resetAtMs: input.resetAtMs,
      windowStartMs: input.windowStartMs,
      knobs: { ...DEFAULT_TASK_PACING_KNOBS, ...(input.knobs ?? {}) },
      ...(input.stamp !== undefined ? { stamp: input.stamp } : {}),
    });
    return Number.isFinite(plan.allowance) ? plan.allowance : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Eligibility and the Thompson draw
// ---------------------------------------------------------------------------

export interface TaskArmEligibilityInput {
  context: TaskBanditContext;
  hints?: TaskContextHints;
  /** Engines that appear among the caller's seats. */
  presentEngines: ReadonlySet<string>;
  /** Per-engine pacing snapshots; absent = constraint inactive. */
  pacing?: Readonly<Record<string, TaskBanditPacingInput>>;
  nowMs: number;
  config: TaskBanditConfig;
}

export interface TaskArmEligibility {
  arms: TaskArm[];
  /** Why no arm is eligible; null when at least one is. */
  holdReason: string | null;
}

/**
 * The arms a decision may draw among: catalog order, restricted to engines
 * the caller actually seats, frontier-only for risky classes and authority
 * roles, and gated by each engine pool's pacing allowance. Credentialed work
 * holds outright. An arm can never name an unknown engine — the catalog
 * itself is the allowlist.
 */
export function eligibleTaskArms(input: TaskArmEligibilityInput): TaskArmEligibility {
  if (input.hints?.needsCredentials === true) {
    return { arms: [], holdReason: 'credentialed work holds; no model seat holds secrets' };
  }
  const frontierOnly = isRiskyContext(input.context, input.hints);
  let arms = TASK_BANDIT_ARMS.filter((a) => isTaskBanditEngine(a.engine) && input.presentEngines.has(a.engine));
  if (arms.length === 0) return { arms, holdReason: 'no seated engine hosts an arm' };
  if (frontierOnly) {
    arms = arms.filter((a) => isFrontierTaskEngine(a.engine));
    if (arms.length === 0) return { arms, holdReason: 'risky class stays frontier-only and no frontier engine is seated' };
  }
  if (input.pacing !== undefined) {
    const paced = arms.filter((a) => {
      const allowance = pacingAllowance(a.engine, input.pacing, input.nowMs);
      return allowance !== null && allowance > input.config.pacingFloor;
    });
    if (paced.length === 0) return { arms: paced, holdReason: 'every engine pool is floored or has no admissible pacing plan' };
    arms = paced;
  }
  return { arms, holdReason: null };
}

export interface ArmDraw {
  arm: TaskArm;
  /** Index into contextCellKeys' order; -1 = uninformed prior draw. */
  level: number;
  theta: number;
  posterior: ArmPosterior;
}

/**
 * One Thompson draw per eligible arm from the deepest cell level with
 * `minCellSamples` observations (prior when none qualifies), ordered by the
 * sampled θ descending — the order `routeSeat` tries engines in. Catalog
 * index breaks exact ties, keeping the draw deterministic.
 */
export function sampleTaskArms(
  state: TaskBanditState,
  context: TaskBanditContext,
  arms: readonly TaskArm[],
  config: TaskBanditConfig,
  uniform: UniformSource,
): ArmDraw[] {
  const keys = contextCellKeys(context);
  return arms.map((a, index) => {
    for (let level = 0; level < keys.length; level += 1) {
      const posterior = posteriorAt(state, keys[level]!, a.id);
      if (posterior && posterior.n >= config.minCellSamples) {
        return { arm: a, index, level, theta: betaSample(posterior.a, posterior.b, uniform), posterior };
      }
    }
    const posterior = { a: config.priorMass, b: config.priorMass, n: 0 };
    return { arm: a, index, level: -1, theta: betaSample(posterior.a, posterior.b, uniform), posterior };
  }).sort((x, y) => (y.theta - x.theta) || (x.index - y.index));
}

// ---------------------------------------------------------------------------
// The decision router.ts applies
// ---------------------------------------------------------------------------

/** Per-invocation bandit input, supplied via `RouteOptions.taskBandit`. */
export interface TaskBanditInput {
  /** Raw `taskBandit` config; parsed strictly. Absent/disabled = flag off. */
  config?: unknown;
  /** Persisted posteriors; absent or malformed → fresh prior. */
  state?: unknown;
  /** Context overrides, authority hints and the item key. */
  hints?: TaskContextHints;
  /** Per-engine pacing snapshots keyed by engine id. */
  pacing?: Readonly<Record<string, TaskBanditPacingInput>>;
}

export interface TaskBanditPlan {
  /** 'off' never reaches a plan — `planTaskBandit` returns null for it. */
  mode: 'shadow' | 'enforce';
  context: TaskBanditContext;
  config: TaskBanditConfig;
  /** Draws in θ order — the engine order routeSeat tries. */
  ordered: ArmDraw[];
  eligibleArmIds: string[];
  holdReason: string | null;
}

/**
 * The pure half of the bandit route: classify, gate and draw, without picking
 * a seat. `routeSeat` applies `ordered` to its engine subsets; callers get a
 * plan even when it is a hold so the annotation stays honest.
 */
export function planTaskBandit(
  req: RoutingRequest,
  input: TaskBanditInput,
  presentEngines: ReadonlySet<string>,
  nowMs: number,
): TaskBanditPlan | null {
  const config = parseTaskBanditConfig(input.config);
  if (!config.enabled || config.mode === 'off') return null;
  const context = classifyTaskContext(req, config, input.hints);
  const eligible = eligibleTaskArms({ context, hints: input.hints, presentEngines, pacing: input.pacing, nowMs, config });
  const state = taskBanditStateFrom(input.state);
  const rng = seededTaskRandom(config.seed, input.hints?.itemKey ?? '');
  const ordered = sampleTaskArms(state, context, eligible.arms, config, rng);
  return {
    mode: config.mode as 'shadow' | 'enforce',
    context,
    config,
    ordered,
    eligibleArmIds: eligible.arms.map((a) => a.id),
    holdReason: eligible.holdReason,
  };
}

/** The annotation carried on `SeatDecision.bandit`. */
export function seatBanditNote(
  plan: TaskBanditPlan,
  appliedArmId: string | null,
): SeatBanditNote {
  const sampledArmId = plan.ordered[0]?.arm.id ?? null;
  const sampledEngine = plan.ordered[0]?.arm.engine ?? null;
  // Divergence is measured at ENGINE granularity — the applied seat depends
  // on the arm's engine alone; model and effort stay advisory either way.
  const appliedEngine = appliedArmId === null ? null : taskArmById(appliedArmId)?.engine ?? null;
  return {
    mode: plan.mode,
    context: plan.context,
    eligibleArmIds: plan.eligibleArmIds,
    sampledArmId,
    appliedArmId,
    // Both null → no divergence; a draw the seat did not take, or a seat the
    // bandit held, diverges.
    divergent: sampledEngine !== appliedEngine,
    holdReason: plan.holdReason,
  };
}

// ---------------------------------------------------------------------------
// Outcome records — the settled-evidence log and the replay estimator
// ---------------------------------------------------------------------------

export const TASK_OUTCOME_SCHEMA = 'phantom-task-bandit-outcome/v1';

/**
 * One settled routing decision's evidence. `arm` is the (engine, model,
 * effort) triple that ACTUALLY ran the work — as an arm id string or the
 * triple itself. `tokens` is total measured input+output for the attempt.
 */
export interface TaskOutcomeRecord {
  readonly schema: typeof TASK_OUTCOME_SCHEMA;
  /** Job/item id; keys the deterministic draw stream in replay. */
  readonly job: string;
  readonly at: string;
  readonly context: {
    readonly taskClass: string;
    /** Measured context size in tokens; bucketed like `contextTokens`. */
    readonly sizeTokens?: number;
    readonly sizeBucket?: TaskSizeBucket;
    readonly riskClass: TaskRiskClass;
    readonly repo: string;
  };
  readonly arm: string | { engine: string; model?: string | null; effort: TaskEffort };
  /** Engines seated at decision time; absent = every catalog engine present. */
  readonly engines?: readonly string[];
  readonly authority?: Pick<TaskContextHints, 'mergesToMain' | 'holdsMergeRights' | 'publishes' | 'needsCredentials'>;
  readonly pacing?: Readonly<Record<string, TaskBanditPacingInput>>;
  readonly merged?: boolean;
  readonly ciGreen?: boolean;
  readonly tokens?: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const RISKS: readonly TaskRiskClass[] = ['low', 'medium', 'high'];
const BUCKETS: readonly TaskSizeBucket[] = ['xs', 's', 'm', 'l', 'xl'];
const EFFORTS: readonly TaskEffort[] = ['low', 'medium', 'high'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function armIdOf(arm: unknown): string | null {
  if (typeof arm === 'string') return arm;
  if (!isObj(arm)) return null;
  const engine = typeof arm['engine'] === 'string' ? arm['engine'] : null;
  const effort = typeof arm['effort'] === 'string' && (EFFORTS as readonly string[]).includes(arm['effort'])
    ? arm['effort'] as TaskEffort : null;
  const model = arm['model'];
  if (engine === null || effort === null) return null;
  if (model !== undefined && model !== null && typeof model !== 'string') return null;
  return `${engine}:${typeof model === 'string' ? model : 'default'}:${effort}`;
}

/**
 * Strict row validation: a malformed record is a hard error naming the field,
 * never a silently skipped sample. An `arm` naming no catalog arm parses but
 * earns no kept credit — it is an unknown engine and can never be drawn.
 */
export function taskOutcomeRecordFrom(raw: unknown): TaskOutcomeRecord {
  if (!isObj(raw)) throw new Error('Outcome record must be an object');
  if (raw['schema'] !== TASK_OUTCOME_SCHEMA) throw new Error(`Outcome record schema must be ${TASK_OUTCOME_SCHEMA}`);
  const job = raw['job'];
  if (typeof job !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(job)) throw new Error('Outcome record needs a job id');
  const at = raw['at'];
  if (typeof at !== 'string' || !ISO_DATE.test(at) || !Number.isFinite(Date.parse(at))) throw new Error('Outcome record needs an ISO `at`');
  const ctx = raw['context'];
  if (!isObj(ctx) || typeof ctx['taskClass'] !== 'string' || !ctx['taskClass'].trim()) throw new Error('Outcome context needs taskClass');
  const riskClass = ctx['riskClass'];
  if (typeof riskClass !== 'string' || !(RISKS as readonly string[]).includes(riskClass)) throw new Error('Outcome context needs riskClass');
  const sizeBucket = ctx['sizeBucket'];
  if (sizeBucket !== undefined && (typeof sizeBucket !== 'string' || !(BUCKETS as readonly string[]).includes(sizeBucket))) {
    throw new Error('Outcome context sizeBucket must be xs..xl');
  }
  const sizeTokens = ctx['sizeTokens'];
  if (sizeTokens !== undefined && (typeof sizeTokens !== 'number' || !Number.isFinite(sizeTokens) || sizeTokens < 0)) {
    throw new Error('Outcome context sizeTokens must be nonnegative');
  }
  if (sizeBucket === undefined && sizeTokens === undefined) throw new Error('Outcome context needs sizeBucket or sizeTokens');
  const arm = raw['arm'];
  if (arm === undefined || arm === null || armIdOf(arm) === null) throw new Error('Outcome record needs an arm');
  const engines = raw['engines'];
  if (engines !== undefined && (!Array.isArray(engines) || engines.some((e) => typeof e !== 'string' || !e.trim()))) {
    throw new Error('Outcome engines must be engine ids');
  }
  const tokens = raw['tokens'];
  if (tokens !== undefined && (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0)) {
    throw new Error('Outcome tokens must be nonnegative');
  }
  const merged = raw['merged'];
  if (merged !== undefined && typeof merged !== 'boolean') throw new Error('Outcome merged must be boolean');
  const ciGreen = raw['ciGreen'];
  if (ciGreen !== undefined && typeof ciGreen !== 'boolean') throw new Error('Outcome ciGreen must be boolean');
  return raw as unknown as TaskOutcomeRecord;
}

/** The record's context cell; sizeTokens buckets exactly like contextTokens. */
export function outcomeContext(record: TaskOutcomeRecord, config: TaskBanditConfig): TaskBanditContext {
  return {
    taskClass: record.context.taskClass,
    sizeBucket: record.context.sizeBucket ?? bucketOf(record.context.sizeTokens, config.sizeEdges),
    riskClass: record.context.riskClass,
    repo: normalizeRepo(record.context.repo),
  };
}

/**
 * Fold one settled outcome into the posteriors — the live-path counterpart of
 * the replay's kept-record update. Caller owns persistence. Never throws:
 * unparseable context fields degrade to the record's own values, and an arm
 * id unknown to the catalog is dropped (no cell gets foreign evidence).
 */
export function recordTaskOutcome(
  state: TaskBanditState,
  record: TaskOutcomeRecord,
  config: TaskBanditConfig,
): TaskBanditState {
  const armId = armIdOf(record.arm);
  if (armId === null || taskArmById(armId) === null) return state;
  const reward = taskOutcomeReward(record, config);
  return updateTaskBanditState(state, outcomeContext(record, config), armId, reward.unit);
}

// ---------------------------------------------------------------------------
// Replay — rejection-sampling counterfactual on fixture history
// ---------------------------------------------------------------------------

export interface TaskBanditReplayMetrics {
  records: number;
  merges: number;
  mergeRate: number | null;
  tokens: number;
  /** Merged-and-green PRs per token spent — the task's objective. */
  tokensPerMerge: number | null;
  mergedGreenPerToken: number | null;
}

export interface TaskBanditReplayReport {
  schema: 'phantom-task-bandit-replay/v1';
  estimator: 'rejection-sampling';
  seed: number;
  records: number;
  kept: number;
  keptRate: number | null;
  /** Records dropped because every arm was gated (pacing/credentials/frontier). */
  held: number;
  /** Records whose logged arm is no catalog arm — unknown engines, never drawn. */
  unknownArmRecords: number;
  /** The logged policy's metrics over every record. */
  staticPolicy: TaskBanditReplayMetrics;
  /** The bandit's metrics over the kept records. */
  bandit: TaskBanditReplayMetrics;
  /** The logged policy over the SAME kept subset — matched-evidence control. */
  staticOnKept: TaskBanditReplayMetrics;
  /** Every arm id the bandit drew during replay (θ-order first draw). */
  drawnArmIds: readonly string[];
}

function metricsOf(records: readonly { merged?: boolean; ciGreen?: boolean; tokens?: number }[]): TaskBanditReplayMetrics {
  const merges = records.filter((r) => r.merged === true && r.ciGreen === true).length;
  const tokens = records.reduce((sum, r) => sum + (typeof r.tokens === 'number' && Number.isFinite(r.tokens) && r.tokens > 0 ? r.tokens : 0), 0);
  return {
    records: records.length,
    merges,
    mergeRate: records.length > 0 ? merges / records.length : null,
    tokens,
    tokensPerMerge: merges > 0 ? tokens / merges : null,
    mergedGreenPerToken: tokens > 0 ? merges / tokens : null,
  };
}

/**
 * The offline replay the acceptance runs on fixture history. Per record the
 * bandit — trained only on what it has kept so far — draws among the arms
 * that pass every gate at that record (engines present, frontier for risky,
 * pacing floor). A draw equal to the logged arm credits the record's REAL
 * reward and updates the posteriors; a mismatch drops the record, because a
 * log cannot say what an unchosen arm would have earned.
 *
 * Arms are taken from the record's `engines` list when present; an absent
 * list means every catalog engine was seated. Unknown logged arms are never
 * drawable — they are counted and always dropped.
 */
export function replayTaskBandit(
  records: readonly TaskOutcomeRecord[],
  opts: { seed?: number; config?: TaskBanditConfig } = {},
): TaskBanditReplayReport {
  const config = opts.config ?? parseTaskBanditConfig({ enabled: true, mode: 'enforce' });
  const seed = opts.seed ?? config.seed;
  let state = emptyTaskBanditState();
  const kept: TaskOutcomeRecord[] = [];
  const drawn = new Set<string>();
  let held = 0;
  let unknownArmRecords = 0;
  for (const record of records) {
    const context = outcomeContext(record, config);
    const present = new Set<string>(record.engines ?? TASK_BANDIT_ENGINES);
    const eligible = eligibleTaskArms({
      context,
      hints: { ...(record.authority ?? {}), itemKey: record.job },
      presentEngines: present,
      pacing: record.pacing,
      nowMs: Date.parse(record.at),
      config,
    });
    const loggedArmId = armIdOf(record.arm);
    const loggedKnown = loggedArmId !== null && taskArmById(loggedArmId) !== null;
    if (!loggedKnown) unknownArmRecords += 1;
    if (eligible.arms.length === 0) { held += 1; continue; }
    const draws = sampleTaskArms(state, context, eligible.arms, config, seededTaskRandom(seed, record.job));
    const top = draws[0]!;
    drawn.add(top.arm.id);
    if (top.arm.id !== loggedArmId) continue;
    kept.push(record);
    state = updateTaskBanditState(state, context, top.arm.id, taskOutcomeReward(record, config).unit);
  }
  return {
    schema: 'phantom-task-bandit-replay/v1',
    estimator: 'rejection-sampling',
    seed,
    records: records.length,
    kept: kept.length,
    keptRate: records.length > 0 ? kept.length / records.length : null,
    held,
    unknownArmRecords,
    staticPolicy: metricsOf(records),
    bandit: metricsOf(kept),
    staticOnKept: metricsOf(kept),
    drawnArmIds: [...drawn].sort(),
  };
}

/** Parse a fixture log: a JSON array, or one JSON object per line. */
export function parseTaskOutcomeLog(text: string): TaskOutcomeRecord[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const rows: unknown[] = trimmed.startsWith('[')
    ? JSON.parse(trimmed) as unknown[]
    : trimmed.split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
  return rows.map((row) => taskOutcomeRecordFrom(row));
}
