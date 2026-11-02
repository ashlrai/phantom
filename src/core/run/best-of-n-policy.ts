import type { BestOfNCandidateSpec, EngineId } from '../types.js';
import type { BudgetMode } from '../routing/types.js';

/** Hard process/cost containment for one best-of-N selection. */
export const MAX_BEST_OF_N_CANDIDATES = 8;

/**
 * A best-of-N call already consumes one outer daemon slot. Keep its internal
 * producer and critic fan-out smaller so it cannot bypass the fleet governor.
 */
export const MAX_BEST_OF_N_CONCURRENCY = 2;

/** Maximum configured candidate specs inspected before dispatch. */
export const MAX_BEST_OF_N_CANDIDATE_SPECS_INSPECTED = 64;

/**
 * Resolve an untrusted/configured candidate count conservatively.
 * Invalid values fail closed to one candidate; valid values are floored and
 * clamped to the hard maximum.
 */
export function resolveBestOfNCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_BEST_OF_N_CANDIDATES, Math.floor(value));
}

// ---------------------------------------------------------------------------
// V3.10 (SPEC-310B §3 Routing): autonomous best-of-N candidate plan
// ---------------------------------------------------------------------------


export type AutonomousDifficulty = 'low' | 'medium' | 'high';

export interface AutonomousBestOfNInput {
  difficulty: AutonomousDifficulty;
  /** Earlier failed attempts at this work item (rejects, reverts, empty diffs). */
  priorFailures: number;
  mode: BudgetMode;
  /** The SeatRouter admitted the grok-a seat for producing right now. */
  grokEligible: boolean;
  grokModel?: string;
  /** The free local lane, or null when no local runtime is up. */
  local: { engine: 'llama-server' | 'local-coder'; model: string } | null;
  /** The SeatRouter admitted claude-a for producing right now (all-in only is honoured). */
  claudeEligible: boolean;
  claudeModel?: string;
}

export interface AutonomousBestOfNPlan {
  run: boolean;
  /** Stable machine reason — surfaced in the fleet's "why" views. */
  reason: 'not-needed' | 'no-local-lane' | 'no-engine-diversity' | 'planned';
  candidates: BestOfNCandidateSpec[];
}

/** Local candidates per plan: free compute, varied by best-of-n's temperature/seed schedule. */
const LOCAL_CANDIDATES = 2;

/**
 * Plan a best-of-N fan-out for one autonomous work item. PURE.
 *
 * When: difficulty `high`, or the item already failed once — a single cheap
 * attempt is the default everywhere else (best-of-N costs N producers).
 *
 * What: one frontier candidate + two local candidates. The frontier candidate
 * is grok-cli (Grok reserve 0%, so it is the seat autonomy is meant to use);
 * Claude joins ONLY in `all-in` mode, and only replaces Grok when Grok is not
 * admitted — `balanced` and `reserve` keep claude-a for Mason. Engine
 * diversity is REQUIRED: without a frontier candidate the set would be two
 * samples of one local model, which best-of-n's judge cannot meaningfully
 * separate, so the plan declines (`no-engine-diversity`) and the item runs as
 * a single local attempt.
 */
export function planAutonomousBestOfN(input: AutonomousBestOfNInput): AutonomousBestOfNPlan {
  const failures = Number.isFinite(input.priorFailures) ? Math.max(0, Math.floor(input.priorFailures)) : 0;
  if (input.difficulty !== 'high' && failures < 1) return { run: false, reason: 'not-needed', candidates: [] };
  if (!input.local || !input.local.model.trim()) return { run: false, reason: 'no-local-lane', candidates: [] };
  let frontier: BestOfNCandidateSpec | null = null;
  if (input.grokEligible) {
    frontier = { engine: 'grok-cli' as EngineId, ...(input.grokModel ? { model: input.grokModel } : {}) };
  } else if (input.claudeEligible && input.mode === 'all-in') {
    frontier = { engine: 'claude', ...(input.claudeModel ? { model: input.claudeModel } : {}) };
  }
  if (!frontier) return { run: false, reason: 'no-engine-diversity', candidates: [] };
  const localSpec: BestOfNCandidateSpec = { engine: input.local.engine as EngineId, model: input.local.model };
  const candidates = [frontier, ...Array.from({ length: LOCAL_CANDIDATES }, () => ({ ...localSpec }))];
  // In all-in mode with both seats admitted, Claude is an ADDITIONAL candidate.
  if (input.mode === 'all-in' && input.grokEligible && input.claudeEligible) {
    candidates.splice(1, 0, { engine: 'claude', ...(input.claudeModel ? { model: input.claudeModel } : {}) });
  }
  return { run: true, reason: 'planned', candidates: candidates.slice(0, MAX_BEST_OF_N_CANDIDATES) };
}

// ---------------------------------------------------------------------------
// ONE-ASK-FLOW (VISION-V4): best-of-N winner rule
// ---------------------------------------------------------------------------

/**
 * The evidence one ask attempt contributes to winner selection. Structural on
 * purpose: a run/best-of-n candidate, a fleet ledger row and an
 * ask.status.v1-shaped record each project onto it without this module
 * importing their homes. `index` is the attempt's position in its fan-out and
 * supplies the final deterministic tiebreak, so equal candidates resolve the
 * same way no matter what order the caller iterates.
 */
export interface OneAskBestOfNCandidate {
  /** Attempt position in its fan-out — the last, deterministic tiebreak. */
  index: number;
  /** Unified diff the attempt produced; empty or whitespace-only is no material. */
  diff: string;
  /** true = verification suite passed; false = ran and failed; undefined = never ran. */
  testsPassed?: boolean;
  /**
   * Collapsed judge verdict score (the scoreVerdict convention:
   * fleet/verdict-score.ts). Absent, non-finite or NaN counts as 0 —
   * "no considered verdict" — and never outranks a real score.
   */
  score?: number;
  /**
   * Total input + output tokens the attempt consumed (ask.status.v1
   * `tokens_total`). Absent or non-finite counts as unmeasured and loses the
   * token tiebreak to every measured attempt, so an uninstrumented producer
   * cannot win a cost comparison it never reported.
   */
  tokens?: number;
  /** Producer or judge error evidence; a non-empty string marks failure. */
  error?: string;
  /** Explicit terminal failure (e.g. ask.status.v1 state 'failed'). */
  failed?: boolean;
}

/**
 * The ONE-ASK-FLOW drop rule. PURE, never throws.
 *
 * A candidate is failing — never eligible to win — when it terminated in
 * failure (`failed`), carries error evidence (`error`), ran its verification
 * and failed it (`testsPassed === false`), or produced no diff material.
 * An unverified candidate (testsPassed undefined) stays eligible: absence of
 * verification is ranked, not fatal.
 */
export function isOneAskBestOfNWinnerCandidate(candidate: OneAskBestOfNCandidate): boolean {
  if (candidate == null || typeof candidate !== 'object') return false;
  if (candidate.failed === true) return false;
  if (typeof candidate.error === 'string' && candidate.error.trim().length > 0) return false;
  if (candidate.testsPassed === false) return false;
  return typeof candidate.diff === 'string' && candidate.diff.trim().length > 0;
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function measuredTokens(candidate: OneAskBestOfNCandidate): number {
  const tokens = candidate.tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
    ? tokens
    : Number.POSITIVE_INFINITY;
}

/**
 * The ONE-ASK-FLOW winner ordering. PURE comparator; callers sort eligible
 * candidates ascending and take the first.
 *
 *   1. tests passed — a green suite beats an unverified diff;
 *   2. smaller diff — the minimal correct change wins;
 *   3. verdict — the higher collapsed judge score wins;
 *   4. fewest tokens — measured spend wins, unmeasured loses;
 *   5. index — fan-out order, so the result is deterministic.
 *
 * Eligibility is the caller's concern (isOneAskBestOfNWinnerCandidate); this
 * comparator only orders.
 */
export function compareOneAskBestOfNCandidates(
  a: OneAskBestOfNCandidate,
  b: OneAskBestOfNCandidate,
): number {
  const aPass = a.testsPassed === true ? 1 : 0;
  const bPass = b.testsPassed === true ? 1 : 0;
  if (bPass !== aPass) return bPass - aPass;
  if (a.diff.length !== b.diff.length) return a.diff.length - b.diff.length;
  const aScore = finiteOrZero(a.score);
  const bScore = finiteOrZero(b.score);
  if (bScore !== aScore) return bScore - aScore;
  const aTokens = measuredTokens(a);
  const bTokens = measuredTokens(b);
  if (aTokens !== bTokens) return aTokens - bTokens;
  return finiteOrZero(a.index) - finiteOrZero(b.index);
}

/**
 * Pick the one-ask best-of-N winner: drop failing candidates, then rank the
 * survivors by compareOneAskBestOfNCandidates. PURE, never throws. Returns
 * the winning candidate object itself — never a copy — or undefined when no
 * candidate is eligible (all failing, empty input, non-array input).
 */
export function selectOneAskBestOfNWinner<T extends OneAskBestOfNCandidate>(
  candidates: readonly T[],
): T | undefined {
  if (!Array.isArray(candidates)) return undefined;
  let winner: T | undefined;
  for (const candidate of candidates) {
    if (!isOneAskBestOfNWinnerCandidate(candidate)) continue;
    if (winner === undefined || compareOneAskBestOfNCandidates(candidate, winner) < 0) {
      winner = candidate;
    }
  }
  return winner;
}
