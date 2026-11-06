/** Shared portfolio contracts. Public entry point: ../types.ts. */
import type { GoalStatus } from './goals.js';
import type { HealthGrade } from './health.js';

// ---------------------------------------------------------------------------
// M29: PORTFOLIO DASHBOARD + DIGEST - Ashlr v2 pillar G (surfacing).
//
// SAFE BY CONSTRUCTION. M29 is a READ-ONLY aggregation + a LOCAL daily digest.
// The portfolio snapshot and digest only READ already-local state (index, runs,
// swarms, health snapshots, goals, backlog, inbox, observability rollup/
// forecast, daemon state, genome). They WRITE only under ~/.ashlr/digests/
// (digest artifacts). They NEVER mutate a repo/working tree, NEVER write
// CONFIG_PATH, NEVER apply/approve a proposal, NEVER push/PR/deploy. The ONLY
// outward path is notify() behind an explicit, opt-in `--notify` flag. The v2
// portfolio dimensions (health, goals) are ENROLLMENT-SCOPED (default empty =>
// empty sections, NO portfolio disk scan). Aggregation + rendering is
// deterministic with NO LLM by default; an optional narrative routes through
// getActiveClient(cfg, { allowCloud }) (local-only unless --allow-cloud + key).
// Every source is wrapped so a missing/failed source degrades to a zeroed/empty
// section; list sizes are capped. These types carry METADATA ONLY - no secrets.
// ---------------------------------------------------------------------------

/**
 * M29: org-level HEALTH summary distilled from the M27 HealthReport over
 * ENROLLED repos. Empty (zeros + empty list) when nothing is enrolled or the
 * M27 source is unavailable. METADATA ONLY.
 */
export interface PortfolioHealthSummary {
  /** Number of enrolled repos that were scored (0 when none enrolled). */
  reposScored: number;
  /** Portfolio mean overall score, 0..100 (0 when none). */
  averageScore: number;
  /** Letter grade derived from `averageScore`. */
  averageGrade: HealthGrade;
  /**
   * The worst-scoring repos (lowest score first), bounded to a small cap. Each
   * entry is a compact handle - repo path label, score, grade. METADATA ONLY.
   */
  worstRepos: { repo: string; score: number; grade: HealthGrade }[];
}

/**
 * M29: a single IN-FLIGHT goal surfaced in the portfolio. Derived from the M28
 * Goal record + progressOf() - pure read-only roll-up; references the next
 * actionable milestone by title (read-only handle). METADATA ONLY.
 */
export interface PortfolioGoalInFlight {
  /** The goal id (read-only handle into the M28 goals store). */
  goalId: string;
  /** The high-level objective text. */
  objective: string;
  /** Rolled-up goal lifecycle status. */
  status: GoalStatus;
  /** Fraction of milestones complete, 0..1. */
  fractionDone: number;
  /** Count of milestones that produced a PENDING proposal. */
  proposed: number;
  /** Total milestone count. */
  totalMilestones: number;
  /**
   * Title of the next actionable milestone (lowest-order 'pending'), or null
   * when there is nothing to advance. Read-only display handle.
   */
  nextActionable: string | null;
}

/**
 * M29: a single top BACKLOG item surfaced in the portfolio. Compact projection
 * of an M22 WorkItem - title, repo label, and score. METADATA ONLY.
 */
export interface PortfolioBacklogItem {
  /** Short human-readable title of the work item. */
  title: string;
  /** Absolute path / label of the repo the item belongs to, or null. */
  repo: string | null;
  /** The item's priority score (higher = more important). */
  score: number;
}

/**
 * M29: the COST block of the portfolio - actual spend for the window (from the
 * M19 rollup) plus the M19 CostForecast (local savings + monthly projection).
 * All figures are ESTIMATES. Zeroed on failure. METADATA ONLY.
 */
export interface PortfolioCost {
  /** Window label the cost block is built from (e.g. '7d' | '30d'). */
  window: string;
  /** Actual USD spent in the window (local providers contribute $0). */
  spentUsd: number;
  /** Estimated USD the same local tokens WOULD have cost on cloud (savings). */
  localSavingsUsd: number;
  /** Simple projected monthly USD spend extrapolated from the window's rate. */
  projectedMonthlyUsd: number;
}

/**
 * M29: the EFFECTIVENESS headline - a one-line read-only projection of the most
 * recent M26 ReflectionReport + its week-over-week delta. Absent when there is
 * no reflect report. METADATA ONLY.
 */
export interface PortfolioEffectiveness {
  /** Success rate from the latest reflection report (0..1). */
  successRate: number;
  /** Signed effectiveness delta in percentage points vs prior, or null. */
  effectivenessDeltaPct: number | null;
  /** Deterministic one-line headline (templated by M26's computeDelta). */
  headline: string;
}

/**
 * M29: the "today" DELTA block - day-over-day movements computed against the
 * previous persisted digest (loadPreviousDigest). All deltas are signed and
 * null when there is no prior digest to compare against. Pure read-only
 * arithmetic - mutates NOTHING. METADATA ONLY.
 */
export interface PortfolioTodayDelta {
  /** ISO timestamp of the prior digest this block compares against, or null. */
  previousAt: string | null;
  /** Signed change in pending inbox proposals since the prior digest, or null. */
  pendingProposalsDelta: number | null;
  /** Signed change in dirty repos since the prior digest, or null. */
  dirtyReposDelta: number | null;
  /** Signed change in window spend (USD) since the prior digest, or null. */
  spendUsdDelta: number | null;
  /** Signed change in portfolio average health score since the prior, or null. */
  healthScoreDelta: number | null;
  /** Signed change in count of in-flight goals since the prior digest, or null. */
  goalsInFlightDelta: number | null;
}

/**
 * M29: the OPTIONAL org-level portfolio section embedded in DashboardSnapshot.
 * Each field is independently degradable - an empty enrollment / missing source
 * leaves that field at its empty/zeroed default with NO disk scan. READ-ONLY
 * aggregation only. METADATA ONLY - never carries secret values.
 */
export interface PortfolioSummary {
  /** Health roll-up over ENROLLED repos (M27). Empty when none enrolled. */
  health: PortfolioHealthSummary;
  /** In-flight goals (M28), bounded to a small cap, most-progressed first. */
  goalsInFlight: PortfolioGoalInFlight[];
  /** Top scored backlog work items (M22), bounded to a small cap. */
  backlogTop: PortfolioBacklogItem[];
  /** Cost + forecast for the dashboard window (M19). */
  cost: PortfolioCost;
  /** Effectiveness headline from the latest reflection report (M26), or null. */
  effectiveness: PortfolioEffectiveness | null;
  /** Day-over-day "today" deltas vs the previous digest (M29 store). */
  today: PortfolioTodayDelta;
}

/**
 * M29: window accepted by the digest + portfolio cost block. Mirrors the M19
 * forecast windows. Defaults to '7d'.
 */
export type DigestWindow = '7d' | '30d';

/**
 * M29: options for buildDigest. LOCAL-FIRST: no model is used unless
 * `allowCloud` opens the local-first provider chain (Ollama/LM Studio only
 * unless a cloud key is configured). `window` controls the cost block.
 */
export interface DigestOptions {
  /** Cost/forecast window. Default '7d'. */
  window?: DigestWindow;
  /**
   * OPT-IN: attempt an optional LLM-assisted narrative. Default false =
   * deterministic-only, NO model is ever constructed (mirrors the M26 reflect
   * `narrative` gate). Even a reachable LOCAL provider is NOT consulted unless
   * this is true - so the default `ashlr digest` path makes ZERO model calls.
   */
  narrative?: boolean;
  /**
   * When `narrative` is true, permit a CLOUD model for it (routed through
   * getActiveClient(cfg, { allowCloud })). Default false = local-only (Ollama/
   * LM Studio), ZERO non-localhost connections. Has NO effect unless
   * `narrative` is also true.
   */
  allowCloud?: boolean;
}

/**
 * M29: the deterministic DAILY DIGEST report. Built from a portfolio snapshot
 * (DashboardSnapshot incl. its `portfolio` section) plus day-over-day deltas vs
 * the previous persisted digest. Persisted as JSON + markdown under
 * ~/.ashlr/digests/ and used as the prior for the next day's deltas. Computed
 * entirely WITHOUT an LLM on the default path. METADATA ONLY - no secrets.
 */
export interface DigestReport {
  /** ISO timestamp the digest was generated. */
  generatedAt: string;
  /** Calendar day (YYYY-MM-DD) the digest summarizes. */
  date: string;
  /** Cost/forecast window the digest's cost figures use. */
  window: DigestWindow;
  /**
   * The portfolio section that backs this digest (snapshot of the org view at
   * generation time). Carries health/goals/backlog/cost/effectiveness/today.
   */
  portfolio: PortfolioSummary;
  /** Compact repo roll-up at generation time (from the base DashboardSnapshot). */
  repos: { total: number; dirty: number; stale: number };
  /** Pending inbox proposals awaiting approval at generation time (M23). */
  pendingProposals: number;
  /** Operator (daemon) status at generation time (M24), or null when absent. */
  daemon: { running: boolean; todaySpentUsd: number } | null;
  /**
   * Deterministic one-line human headline summarizing the day (templated; no
   * LLM). Always present.
   */
  headline: string;
  /**
   * Optional LLM-assisted narrative summary. ABSENT on the default path
   * (deterministic-only). Populated ONLY when narrative generation is requested
   * and a provider is reachable (local unless --allow-cloud + key). When set,
   * `narrativeLocal` records whether it was produced by a local model.
   */
  narrative?: string;
  /** True when `narrative` was produced by a LOCAL model; absent when none. */
  narrativeLocal?: boolean;
  /**
   * M88: fleet activity digest - per-repo proposal stats + daemon counters.
   * Absent when no fleet activity has occurred or the store is unavailable
   * (never-throws, best-effort). Included in --json output.
   */
  fleet?: import('../fleet/digest.js').FleetDigest;
}

/**
 * M29: outcome of deliverDigest - exactly what happened. The local artifact is
 * ALWAYS written; `notified` is true ONLY when `notify:true` was passed AND
 * notify() actually delivered to a configured webhook. METADATA ONLY.
 */
export interface DigestDeliveryResult {
  /** Absolute path of the JSON artifact written, or null on write failure. */
  jsonPath: string | null;
  /** Absolute path of the markdown artifact written, or null on write failure. */
  markdownPath: string | null;
  /**
   * Whether the digest was delivered outward via notify(). FALSE on the default
   * path (no --notify) and when no webhook is configured. The ONLY outward path.
   */
  notified: boolean;
}

/**
 * M31: composite session-start orientation - "what should I know before I
 * start working here". Every section is BEST-EFFORT (empty on failure); the
 * builder never throws. READ-ONLY: derived entirely from local stores.
 */
export interface OrientResult {
  /** ISO timestamp the orientation was generated. */
  generatedAt: string;
  /** Absolute repo path the orientation is scoped to, or null for portfolio-wide. */
  repo: string | null;
  /** Top genome memory hits relevant to the repo/query (bounded). */
  genomeHits: { title: string; text: string; score: number; project: string | null }[];
  /** Latest health score for the repo (null when none recorded / not enrolled). */
  health: { score: number; grade: string; worstDimensions: string[] } | null;
  /** Top persisted backlog items for the repo (empty when no backlog built). */
  backlogItems: { id: string; source: string; title: string; score: number }[];
  /** Number of PENDING inbox proposals awaiting the human. */
  pendingProposals: number;
  /** Portfolio attention summary from the index (dirty/stale repo counts). */
  attention: { dirtyRepos: number; staleRepos: number } | null;
}
