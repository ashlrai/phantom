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
  mode: BudgetMode;
  /** Keyed by seat id; a seat absent here gets the mode's default policy. */
  seats: Record<string, SeatBudgetPolicy>;
  /** ISO time of the last change. */
  updatedAt: string;
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

/** Output of the pure `routeSeat(req, capacity, policy)`. */
export interface SeatDecision {
  /** Chosen seat; null when no seat is eligible. */
  seatId: string | null;
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
  /**
   * Task-bandit annotation (RQ-PARITYROUTERTASKQ7, additive). Present only
   * when the task-aware bandit lane was consulted for this decision —
   * `opts.taskBandit` with an enabled flag on an autonomous request. A
   * flag-off decision carries no `bandit` field at all.
   */
  bandit?: SeatBanditNote;
}

// ---------------------------------------------------------------------------
// Task-aware bandit lane (RQ-PARITYROUTERTASKQ7, extends the #960 lane)
// ---------------------------------------------------------------------------

/**
 * The engines a task-aware arm may name — Claude Code, Codex, Grok, Devin and
 * the local runtimes (oMLX rides the `local` engine in this router). The set
 * deliberately mirrors `BudgetEngine` MINUS `claude-api`, which is never
 * commissioned. An engine id outside this set is unknown: it is never an arm
 * and can never be selected by the bandit.
 */
export type TaskBanditEngine = 'claude' | 'codex' | 'grok' | 'devin' | 'local';

/**
 * The risk class a task falls in. `high` is the risky class: per #926 it
 * stays frontier-only — no arm whose engine is not hosted may be picked.
 */
export type TaskRiskClass = 'low' | 'medium' | 'high';

/** Effort an arm asks of its engine, on the `RoutingDifficulty` scale. */
export type TaskEffort = 'low' | 'medium' | 'high';

/** Context-size buckets; `TaskBanditConfig.sizeEdges` maps tokens onto them. */
export type TaskSizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl';

/**
 * One cell of the task classifier: (class, size, risk, repo). Every settled
 * observation updates the arm posterior at this exact cell and at its three
 * generalizations (repo-free, size-free, global), so a new repo or an unseen
 * size borrows strength instead of starting cold.
 */
export interface TaskBanditContext {
  /** What kind of work — the `RoutingTask` of the request that produced it. */
  taskClass: string;
  sizeBucket: TaskSizeBucket;
  riskClass: TaskRiskClass;
  /** Lowercase `owner/name`, or 'unknown' when the caller cannot say. */
  repo: string;
}

/**
 * One arm: a concrete (engine, model, effort) triple. `model` is advisory —
 * the seat router admits a SEAT, and dispatch applies the arm's model and
 * effort to it downstream; null means the engine's own default.
 */
export interface TaskArm {
  /** Stable id recorded on outcomes: `<engine>:<model|default>:<effort>`. */
  id: string;
  engine: TaskBanditEngine;
  model: string | null;
  effort: TaskEffort;
}

/** What the bandit lane records on a `SeatDecision` (additive `bandit`). */
export interface SeatBanditNote {
  /** The flag mode this decision ran under ('off' adds no field at all). */
  mode: 'shadow' | 'enforce';
  /** The classified context the pick was made under. */
  context: TaskBanditContext;
  /** Arm ids that passed every gate, in catalog order. */
  eligibleArmIds: string[];
  /** The Thompson draw — what the bandit would route; null on a hold. */
  sampledArmId: string | null;
  /** The arm whose engine-seat subset produced the applied seat (enforce). */
  appliedArmId: string | null;
  /** True when the sampled arm differs from the arm the seat belongs to. */
  divergent: boolean;
  /** Why the bandit held; null when it routed. */
  holdReason: string | null;
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
