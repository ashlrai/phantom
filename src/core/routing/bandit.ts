/**
 * bandit.ts - RQ-OT-P1-BANDIT: contextual Thompson sampler over the routing arm
 * registry (src/core/routing/arms.ts, landed in RQ-OT-P1-ARMS).
 *
 * One store, many contexts. There is deliberately no second arms store here:
 * every posterior lives in the existing ArmRegistry under a CONTEXT-QUALIFIED
 * arm key. `contextualArmKey` appends `<tier>.<repo>.<diffClass>` to the arm's
 * effort segment, so the plain `armKey(arm)` string is always a prefix of the
 * stored key and `parseArmKey`/`loadArmRegistry`/`saveArmRegistry` accept the
 * file unchanged. The same arm under a different context is a different key:
 * that per-(context, arm) posterior is exactly what makes the sampler
 * contextual. Registry keys are addresses, not payloads - context parts are
 * sanitized and never parsed back into routing metadata.
 *
 * Reward (spec): `merged PR x impact weight / plan-allowance spent`.
 *   - merged          -> Beta(merge) evidence, scaled by the impact weight.
 *                        `src/core/metrics/impact.ts` is not present in this
 *                        tree, so `BanditOutcome.impact` defaults to 1; when an
 *                        impact module or the `phm metrics ingest` job feed
 *                        supplies a weight for the merged PR, callers record it
 *                        through `BanditOutcome.impact` and the merge evidence
 *                        scales by it. Impact weight applies to merges only;
 *                        a failed attempt always counts one full failure.
 *   - allowance spent -> Gamma(shape, rate) cost channel. `updateArm`'s gamma
 *                        models the rate of an exponential over plan-allowance
 *                        units consumed, so each observation adds the spent
 *                        allowance to `rate`.
 *   - sampled score   = betaSample(merge) x gammaSample(cost): a Thompson draw
 *                        of weighted merges per allowance unit. Higher is
 *                        better; cheap arms sample large rates.
 *
 * Determinism: `createSeededRng` is a pure seeded PRNG (no Math.random, no
 * clock). Identical (seed, registry, candidate set, context) inputs always
 * produce the identical arm; routeTask seeds with the work item id so a route
 * is stable across calls and testable.
 *
 * Selection reads the registry; only `recordOutcome` mutates it. Callers own
 * load/update/save serialization exactly as arms.ts requires.
 */

import {
  armKey,
  armPrior,
  updateArm,
  type ArmKey,
  type ArmPosterior,
  type ArmRegistry,
} from './arms.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Canonical diff-size classes. Callers may use other labels; these are the three routeTask emits. */
export type DiffSizeClass = 'small' | 'medium' | 'large';

/**
 * The discrete context a bandit decision is conditioned on: the routing tier,
 * the repo the work belongs to, and the estimated diff-size class.
 */
export interface BanditContext {
  /** Routing tier label (e.g. modelTierForTask's fast|mid|computer|work|frontier). */
  tier: string;
  /** Repo identity (basename is enough; sanitized into the key). */
  repo: string;
  /** Diff-size class label. */
  diffClass: string;
}

/** Per-segment caps keep a contextual effort segment under arms.ts's 127-char limit. */
const CONTEXT_PART_MAX = 32;

/**
 * Coerce any label into one arms.ts PART segment fragment: lowercase
 * [a-z0-9._-], alnum-leading, at most `max` chars, never empty.
 */
export function sanitizeContextPart(raw: string, max = CONTEXT_PART_MAX): string {
  let s = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[._-]+$/, '');
  if (s.length > max) s = s.slice(0, max).replace(/[._-]+$/, '');
  return s === '' ? 'x' : s;
}

/**
 * The registry key for `arm` under `ctx`: `provider:model:effort.tier.repo.diff`.
 * Every segment is sanitized, so arms that are invalid under the strict
 * `armKey` alphabet (a model tag containing ':', a repo path) still get a
 * stable address. Never throws for nonempty arm fields.
 */
export function contextualArmKey(arm: ArmKey, ctx: BanditContext): string {
  const effort = [
    sanitizeContextPart(arm.effort, 24),
    sanitizeContextPart(ctx.tier, 24),
    sanitizeContextPart(ctx.repo, 48),
    sanitizeContextPart(ctx.diffClass, 24),
  ].join('.');
  return armKey({
    provider: sanitizeContextPart(arm.provider, 24),
    model: sanitizeContextPart(arm.model, 48),
    effort,
  });
}

/** Stable printable context identity, used in decision reasons. */
export function banditContextLabel(ctx: BanditContext): string {
  return `${sanitizeContextPart(ctx.tier)}/${sanitizeContextPart(ctx.repo)}/${sanitizeContextPart(ctx.diffClass)}`;
}

// ---------------------------------------------------------------------------
// Seeded RNG - deterministic, no Math.random, no clock
// ---------------------------------------------------------------------------

/** Deterministic uniform/normal source. `next()` returns [0, 1). */
export interface BanditRng {
  next(): number;
  /** Standard normal via Box-Muller; consumes `next()` draws in pairs order. */
  normal(): number;
}

/** 32-bit FNV-1a so string seeds (work item ids) become uint32 states. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 over a seeded uint32 state. Zero state is remapped so a seed of
 * 0 or a hash that lands on 0 cannot stall the generator.
 */
export function createSeededRng(seed: string | number): BanditRng {
  let state = (typeof seed === 'number' ? seed >>> 0 : fnv1a(seed)) || 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return {
    next,
    normal() {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      const u = Math.max(next(), Number.MIN_VALUE);
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      const t = 2 * Math.PI * v;
      spare = r * Math.sin(t);
      return r * Math.cos(t);
    },
  };
}

// ---------------------------------------------------------------------------
// Posterior sampling - Beta via two Gamma draws, Gamma via Marsaglia-Tsang
// ---------------------------------------------------------------------------

/** (0, 1]: rejection samplers and the shape<1 boost must never see a literal 0. */
function openUnit(rng: BanditRng): number {
  return Math.max(rng.next(), Number.MIN_VALUE);
}

/**
 * One draw from Gamma(shape, rate), rate-parameterized to match
 * ArmPosterior.cost: observing cost x adds x to `rate`, so a larger drawn
 * value means a cheaper arm. Marsaglia-Tsang; shape<1 uses the standard
 * Gamma(a+1) x U^(1/a) boost (our posteriors are >= 1, but stay total).
 */
export function gammaSample(shape: number, rate: number, rng: BanditRng): number {
  if (!Number.isFinite(shape) || shape <= 0 || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Invalid gamma parameters');
  }
  if (shape < 1) {
    return gammaSample(shape + 1, rate, rng) * Math.pow(openUnit(rng), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = rng.normal();
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = Math.log(openUnit(rng));
    if (u < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / rate;
  }
}

/** One draw from Beta(alpha, beta) as X/(X+Y) over two Gamma(., 1) draws. */
export function betaSample(alpha: number, beta: number, rng: BanditRng): number {
  const x = gammaSample(alpha, 1, rng);
  const y = gammaSample(beta, 1, rng);
  const s = x + y;
  return s > 0 && Number.isFinite(s) ? x / s : 0.5;
}

// ---------------------------------------------------------------------------
// Reward and outcome recording
// ---------------------------------------------------------------------------

/**
 * One observed outcome for a chosen arm. `impact` is the weight of the merged
 * PR from src/core/metrics/impact.ts (or the ingest feed's `impact` field)
 * when present; absent means 1. `allowanceSpent` is the plan-allowance the
 * attempt consumed (e.g. the catalog planAllowanceWeight for the dispatched
 * model, or a measured spend when a caller has one).
 */
export interface BanditOutcome {
  merged: boolean;
  allowanceSpent: number;
  impact?: number;
}

/** Smallest allowance denominator so a zero-allowance merge stays finite. */
export const BANDIT_MIN_ALLOWANCE = 1e-6;

function validOutcome(merged: unknown, allowanceSpent: number, impact: number): merged is boolean {
  return (
    typeof merged === 'boolean' &&
    Number.isFinite(allowanceSpent) &&
    allowanceSpent >= 0 &&
    Number.isFinite(impact) &&
    impact > 0
  );
}

/**
 * The scalar reward of an outcome: `impact / allowanceSpent` for a merged PR
 * (impact defaulting to 1), `0` for anything unmerged. Reported for callers
 * that want the reward itself; the posterior channels below carry the same
 * information into the store.
 */
export function banditReward(outcome: BanditOutcome): number {
  const impact = outcome.impact === undefined ? 1 : outcome.impact;
  if (!validOutcome(outcome.merged, outcome.allowanceSpent, impact)) {
    throw new Error('Invalid bandit outcome');
  }
  if (!outcome.merged) return 0;
  return impact / Math.max(outcome.allowanceSpent, BANDIT_MIN_ALLOWANCE);
}

/**
 * `updateArm` generalized to an impact-weighted merge: a merged outcome adds
 * `weight` to alpha instead of 1; failures still add exactly 1 to beta and
 * every outcome adds `costPerUnit` allowance to the gamma rate. weight === 1
 * is byte-identical to updateArm (which supplies the base validation).
 */
export function updateArmWeighted(
  posterior: ArmPosterior,
  merged: boolean,
  costPerUnit: number,
  weight = 1,
): ArmPosterior {
  const base = updateArm(posterior, merged, costPerUnit);
  if (!Number.isFinite(weight) || weight <= 0) throw new Error('Invalid arm observation');
  if (!merged || weight === 1) return base;
  const next: ArmPosterior = {
    merge: { alpha: base.merge.alpha + (weight - 1), beta: base.merge.beta },
    cost: base.cost,
  };
  if (!Number.isFinite(next.merge.alpha) || next.merge.alpha <= 0) {
    throw new Error('Arm posterior overflow');
  }
  return next;
}

/**
 * Record one outcome for `arm` under `ctx`: fetch (or seed) the contextual
 * posterior and replace it with the weighted update. Mutates and returns the
 * registry for the caller's read-modify-write; persistence stays in arms.ts.
 */
export function recordOutcome(
  registry: ArmRegistry,
  ctx: BanditContext,
  arm: ArmKey,
  outcome: BanditOutcome,
): ArmRegistry {
  const key = contextualArmKey(arm, ctx);
  const posterior = registry.get(key) ?? armPrior();
  const impact = outcome.impact === undefined ? 1 : outcome.impact;
  registry.set(key, updateArmWeighted(posterior, outcome.merged, outcome.allowanceSpent, impact));
  return registry;
}

/** The posterior a candidate would be sampled from right now (prior when absent). */
export function posteriorFor(
  registry: ReadonlyMap<string, ArmPosterior>,
  ctx: BanditContext,
  arm: ArmKey,
): ArmPosterior {
  return registry.get(contextualArmKey(arm, ctx)) ?? armPrior();
}

// ---------------------------------------------------------------------------
// Thompson selection
// ---------------------------------------------------------------------------

export interface BanditSelection {
  /** The winning arm as passed in (unsanitized). */
  arm: ArmKey;
  /** Its registry key under this context. */
  key: string;
  /** The posterior it was sampled from (prior for a cold arm). */
  posterior: ArmPosterior;
  /** betaSample(merge) x gammaSample(cost); higher won. */
  score: number;
}

/**
 * Contextual Thompson pick: draw each candidate's sampled reward-per-allowance
 * from its posterior under `ctx` and return the argmax. Candidates are
 * deduplicated and tried in sorted key order so a given seed always consumes
 * the rng identically; equal scores keep the lexicographically smaller key.
 * Cold arms draw from the uninformative armPrior(), which is the exploration
 * term. Returns null for an empty candidate set - the caller's fallback is
 * then byte-identical to today.
 */
export function selectArm(
  registry: ReadonlyMap<string, ArmPosterior>,
  ctx: BanditContext,
  candidates: readonly ArmKey[],
  rng: BanditRng,
): BanditSelection | null {
  const unique = new Map<string, ArmKey>();
  for (const arm of candidates) {
    const key = contextualArmKey(arm, ctx);
    if (!unique.has(key)) unique.set(key, arm);
  }
  const ordered = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let best: BanditSelection | null = null;
  for (const [key, arm] of ordered) {
    const posterior = registry.get(key) ?? armPrior();
    const score =
      betaSample(posterior.merge.alpha, posterior.merge.beta, rng) *
      gammaSample(posterior.cost.shape, posterior.cost.rate, rng);
    if (best === null || score > best.score) best = { arm, key, posterior, score };
  }
  return best;
}
