/**
 * Budget modes + seat routing — V3.10 contract (unit A0, frozen once written).
 *
 * Decides WHICH seat autonomous (and optionally interactive) work may use,
 * under the operator's budget mode, so the fleet never eats the headroom
 * Mason needs for his own live sessions.
 *
 *   all-in   — autonomy may use all available usage.
 *   balanced — autonomy stops at a per-seat reserve (default).
 *   reserve  — autonomy uses free local models plus only a small paid cap.
 *
 * Honesty rule: unknown usage is NOT headroom. A seat whose window reading is
 * null is ineligible for autonomy (closes the old Claude fail-open).
 *
 * BROWSER-SAFE: the budget UI imports this — type-only imports, plain consts.
 */

import type { SchedulingView } from './scheduling-types.js';

export type BudgetMode = 'all-in' | 'balanced' | 'reserve';

export const BUDGET_MODES: readonly BudgetMode[] = ['all-in', 'balanced', 'reserve'];

export interface SeatBudgetPolicy {
  seatId: string;
  /** Absent inherits the global reset preference; false excludes this account. */
  resetSpending?: boolean;
  /** false = autonomy never uses this seat (e.g. codex while it has no usage). */
  enabled: boolean;
  /** Percent (0–100) of the BINDING window kept back for Mason's interactive use. */
  reservePercent: number;
  /**
   * Autonomy may not touch the seat while its short (5-hour) window is above
   * this percent used — protects a live session. Absent = no session ceiling.
   */
  maxSessionWindowPercent?: number;
  /** Hard daily spend cap in USD for metered seats. Absent = no USD cap. */
  dailyUsdCap?: number;
}

export interface BudgetPolicy {
  /** Absent retains legacy reset ranking only; taper requires explicit enabled=true. */
  resetSpending?: { enabled: boolean };
  /**
   * Task-aware arms (additive flag). Absent, `enabled: false`, or a class with
   * no valid arm leaves every route byte-identical to the baseline ranking.
   * The flag lives only in the stored policy file; `POST /api/verse/budget`
   * cannot change it.
   */
  taskArms?: TaskArmsPolicy;
  mode: BudgetMode;
  /** Keyed by seat id; a seat absent here gets the mode's default policy. */
  seats: Record<string, SeatBudgetPolicy>;
  /** ISO time of the last change. */
  updatedAt: string;
}

/** Every value `RoutingTask` can take (runtime list for validators). */
export const ROUTING_TASKS: readonly RoutingTask[] = ['code', 'review', 'plan', 'bulk', 'leader'];

export const ARM_EFFORTS = ['low', 'medium', 'high'] as const;
/** Reasoning effort an arm asks the dispatch lane for. */
export type ArmEffort = (typeof ARM_EFFORTS)[number];

/**
 * A per-arm token pacing budget over a rolling window: while the flag is on,
 * an arm may serve work only while its observed spend in the current window
 * is not ahead of the linear pace ceiling (see `paceCeilingAt` in
 * resources/pacing.ts). Atomic jobs may cross the ceiling by their size.
 */
export interface TaskArmPace {
  /** Rolling window length in milliseconds (1 ms .. 30 days). */
  windowMs: number;
  /** Tokens the arm may spend per window (1 .. 1e15). */
  budgetTokens: number;
  /**
   * How far ahead of the ideal pace line the arm may run, as a fraction of
   * `budgetTokens` (0..1, default `TASK_ARM_PACE_LEAD` in router.ts). A lead
   * keeps a slow window from stalling a bursty arm.
   */
  leadFraction?: number;
}

/**
 * One task-class arm: an (engine, model, effort) execution shape a class of
 * autonomous work may run on. `engine` must name a `BudgetEngine` (policy.ts)
 * to ever be selectable; any other value can never match a seat. `model` is
 * the exact model the dispatch lane should run (`null` = the seat's default);
 * the seat router does not verify the seat's catalog. `id` names the arm for
 * outcome joins; absent, the key is `engine|model|effort`.
 */
export interface TaskArm {
  id?: string;
  engine: string;
  model: string | null;
  effort: ArmEffort;
  pace?: TaskArmPace;
}

/**
 * The task-aware arm flag and its per-class arm lists. A class absent from
 * `classes` (or whose list holds no valid arm) keeps the baseline ranking;
 * with at least one valid arm, only eligible seats that can serve an
 * admissible arm may take that class of work.
 */
export interface TaskArmsPolicy {
  enabled: boolean;
  classes: Partial<Record<RoutingTask, TaskArm[]>>;
}

/**
 * What a seat reason is about (3.10.1) — lets a reader derive "eligible again"
 * from data instead of parsing prose. Blockers lift on a CONDITION (switch
 * autonomy on, reconnect, a fresh reading, the grant) or at a TIME (a window
 * reset, a demotion's end); `headroom` and `model-window` are notes, never
 * blockers. Readers must treat an unrecognised kind as `other` (a newer
 * server may add kinds).
 */
export type SeatReasonKind =
  | 'headroom'
  | 'switched-off'
  | 'signed-out'
  | 'unreachable'
  | 'spent'
  | 'reserve'
  | 'session-ceiling'
  | 'unknown-usage'
  | 'spend-cap'
  | 'model-window'
  | 'context'
  | 'grant'
  | 'lane'
  | 'demoted'
  | 'task-arm'
  | 'other';

/** One reason, as data: the sentence and — separately — when it lifts. */
export interface SeatReason {
  kind: SeatReasonKind;
  /** One complete sentence ending in a period, WITHOUT a reset clause. */
  text: string;
  /**
   * Machine-readable instant this blocker lifts on its own (a window reset, a
   * demotion's end). Readers format it in the viewer's zone; null = none known.
   */
  resetsAt?: string | null;
  /**
   * The provider's own reset wording when it publishes no instant (Claude) —
   * rendered verbatim, never parsed into a time.
   */
  resetDescription?: string | null;
}

export interface SeatExclusion {
  seatId: string;
  /**
   * Complete sentences, each carrying its own reset clause — the form the
   * CLI, logs and pre-3.10.1 readers print. `details` is the same list as data.
   */
  reasons: string[];
  /** ISO time the seat is expected to become eligible again; null when unknown / never. */
  nextEligibleAt: string | null;
  /** Structured twin of `reasons`, same order (3.10.1+; absent on older records). */
  details?: SeatReason[];
}

/** The task arm a routed seat is serving; only set when the arm flag is on. */
export interface SeatTaskArm {
  /** The arm's stable key: its `id`, or `engine|model|effort` when it has none. */
  key: string;
  engine: string;
  /** The model the dispatch lane should run; `null` = the seat's default. */
  model: string | null;
  effort: ArmEffort;
  /**
   * The observed merged green PRs per token this arm was ranked on
   * (`RouteOptions.armStats`); `null` when the arm has no measured yield.
   */
  rewardPerToken: number | null;
}

/** Output of the pure `routeSeat(req, capacity, policy)`. */
export interface SeatDecision {
  /** Chosen seat; null when no seat is eligible. */
  seatId: string | null;
  /** The task arm the chosen seat serves (absent unless the arm flag steered). */
  taskArm?: SeatTaskArm;
  /** Eligible seat ids, ranked best-first (the chosen one first when non-null). */
  candidates: string[];
  exclusions: SeatExclusion[];
  /** One plain-language sentence explaining the choice (or why nothing was chosen). */
  why: string;
  /**
   * One SHORT sentence for a headline (3.10.1+): the choice and its reason,
   * without the per-seat detail `exclusions` already carries. Absent on older
   * records — readers fall back to `why`.
   */
  summary?: string;
  mode: BudgetMode;
}

export type RoutingTask = 'code' | 'review' | 'plan' | 'bulk' | 'leader';
export type RoutingDifficulty = 'low' | 'medium' | 'high';

export interface RoutingRequest {
  task: RoutingTask;
  difficulty: RoutingDifficulty;
  /** Estimated context the work needs; absent when unknown. */
  contextTokens?: number;
  /** true = fleet/autonomous work (reserves apply); false = Mason's own interactive request. */
  autonomous: boolean;
}

/**
 * Live headroom for one seat, as shown next to its budget policy. Every
 * percent is 0–100 of that window; null = unknown (and therefore ineligible).
 */
export interface SeatHeadroom {
  seatId: string;
  /** Short (5-hour) window used percent; null when unknown / not applicable. */
  sessionUsedPercent: number | null;
  /** Weekly window used percent; null when unknown / not applicable. */
  weeklyUsedPercent: number | null;
  /** Which window currently binds autonomy; null when none applies (local) or unknown. */
  bindingWindow: 'session' | 'weekly' | null;
  /** Percent of the binding window autonomy may still use after the reserve; null when unknown. */
  autonomyHeadroomPercent: number | null;
  /** ISO reset time of the binding window; null when unknown. */
  resetAt: string | null;
  eligibleForAutonomy: boolean;
  /** Plain-language "why" for this seat's eligibility. */
  reasons: string[];
}

/** GET /api/verse/budget (and the POST response): the policy plus live headroom per seat. */
export interface BudgetResponse extends BudgetPolicy {
  /** Advisory only; absent on older servers. Never changes headroom admission. */
  scheduling?: SchedulingView;
  headroom: SeatHeadroom[];
}

/**
 * POST /api/verse/budget — exactly ONE form per request, so a body can never
 * change more than the operator clicked.
 */
export type BudgetUpdateRequest =
  | { mode: BudgetMode }
  | { resetSpending: { enabled: boolean } }
  | { seatId: string; policy: Partial<Omit<SeatBudgetPolicy, 'seatId'>> };

export const VERSE_BUDGET_PATH = '/api/verse/budget';
