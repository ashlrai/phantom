/** Shared dashboard contracts. Public entry point: ../types.ts. */
import type { PortfolioSummary } from './portfolio.js';

// ---------------------------------------------------------------------------
// M13: surfaces I - watchable hub (interactive TUI + real-time Raycast).
// A bounded, read-only aggregate snapshot drives an auto-refreshing terminal
// dashboard (`ashlr tui` / `ashlr dash`) and feeds the Raycast views.
// ---------------------------------------------------------------------------

/**
 * A single bounded, read-only aggregate of the whole hub at one instant.
 * Built from index/git, runs, swarms, the observability rollup, MCP health,
 * the ecosystem tools registry, and genome health. Drives every TUI tab and
 * the Raycast surfaces. NEVER throws - missing/unavailable sources degrade to
 * zeroed/empty fields. METADATA ONLY - never carries secret values.
 */
export interface DashboardSnapshot {
  /** ISO timestamp the snapshot was generated. */
  generatedAt: string;
  /** Repo roll-up: total indexed repos, dirty working trees, stale/inactive. */
  repos: { total: number; dirty: number; stale: number };
  /** Ecosystem tools roll-up: installed vs. total probed. */
  tools: { installed: number; total: number };
  /** Activity roll-up over the dashboard window (sessions/tokens/cost/commits). */
  activity: { sessions: number; tokens: number; estCostUsd: number; commits: number; hopEfficiency?: import('../observability/hop-events.js').HopRollup };
  /** Recent runs (most-recent first), each with status + cumulative tokens. */
  runs: { id: string; goal: string; status: string; tokens: number }[];
  /** Active/recent swarms with live task burndown + optional current phase. */
  swarms: {
    id: string;
    goal: string;
    status: string;
    tasksDone: number;
    tasksTotal: number;
    phase?: string;
  }[];
  /** MCP server health: name, reachable/ok, and tool count. */
  mcp: { name: string; ok: boolean; tools: number }[];
  /** Genome roll-up: total entries and distinct projects covered. */
  genome: { entries: number; projects: number };
  /** M23: number of proposals awaiting Mason's approval in the inbox gate. */
  inbox: { pending: number };
  /**
   * M24: autonomous-operator (daemon) roll-up. `running` reflects daemon state;
   * `todaySpentUsd` is the operator's spend so far today (resets per day);
   * `pendingProposals` mirrors inbox.pending for the daemon surface. READ-ONLY
   * - surfacing daemon status NEVER applies a proposal or mutates a repo.
   * Optional so existing snapshot producers stay valid until the M24 surface
   * populates it; absent => treat as not running / no daemon spend.
   */
  daemon?: { running: boolean; todaySpentUsd: number; pendingProposals: number };
  /**
   * M49/M300: OPTIONAL fleet control-plane snapshot. Populated by the web
   * dashboard producer so Fleet Dashboard can render queue/lease health without
   * making a second request. READ-ONLY and never carries secrets.
   */
  fleet?: import('../fleet/status.js').FleetStatus;
  /**
   * Perf: OPTIONAL freshness marker for `fleet`. `buildFleetStatus` is now
   * served from a shared cache (see web/fleet-status-cache.ts) so concurrent
   * requests never trigger duplicate full recomputes. `stale: true` means
   * `fleet` is the last good value (still honestly reported, never silently
   * presented as current) while a background refresh is in flight; `ageMs`
   * is how old it is. Absent when the fleet section itself is absent.
   */
  fleetFreshness?: { stale: boolean; ageMs: number };
  /**
   * M29: OPTIONAL org-level portfolio roll-up. ABSENT on existing producers /
   * tests (so they stay valid); populated by buildSnapshot when the v2 sources
   * are present. READ-ONLY aggregation over already-local state - health (M27,
   * ENROLLMENT-SCOPED via computeReport), in-flight goals (M28), top backlog
   * (M22), cost+forecast (M19 rollup/forecast over the local index), and the
   * effectiveness headline (M26 reflect). Each sub-source degrades to its
   * empty/zeroed default on failure; an empty enrollment leaves the
   * enrollment-scoped sections empty with NO portfolio disk scan.
   */
  portfolio?: PortfolioSummary;
  /**
   * M194: OPTIONAL per-engine frontier usage roll-up (calls, tokens, cost,
   * window state). Absent on pre-M194 producers/tests (so they stay valid);
   * populated by buildSnapshot via getFrontierUsageSync. READ-ONLY.
   */
  frontierUsage?: import('../usage/frontier-usage.js').FrontierUsage;
  /**
   * M224: OPTIONAL production scorecard - "is the fleet actually producing?"
   * Proposals by status over 24h, judge verdict breakdown, auto-merges today,
   * active goal summaries, and ships-per-day trend. Absent on pre-M224
   * producers/tests (so they stay valid); populated by buildSnapshot via
   * buildProduction(). READ-ONLY.
   */
  production?: ProductionSummary;
  /**
   * M242: OPTIONAL fleet intelligence panel - learned routing scores (M240),
   * anti-playbook lessons (M235), per-engine scorecards, and recent event-bus
   * activity (M241). Absent on pre-M242 producers/tests (so they stay valid);
   * populated by buildSnapshot via buildIntelligence(). READ-ONLY.
   */
  intelligence?: IntelligenceSummary;
  /**
   * M262: OPTIONAL real-time visibility god-view for dashboard and comms.
   * READ-ONLY; every subsection degrades independently.
   */
  visibility?: import('../web/visibility.js').VisibilitySnapshot;
}

/**
 * M224: glanceable production scorecard embedded in DashboardSnapshot.
 * All counts are over the last 24h unless noted. READ-ONLY - built from the
 * inbox store, judge-trace store, and goals store. NEVER carries secrets.
 */
export interface ProductionSummary {
  /** ISO timestamp this summary was built (same as DashboardSnapshot.generatedAt). */
  generatedAt: string;
  /** Proposal counts over the last 24h (only proposals whose createdAt is within window). */
  proposals24h: {
    pending: number;
    applied: number;
    rejected: number;
    total: number;
  };
  /** Judge verdict counts over the last 24h (from judge-trace JSONL). */
  judgeVerdicts24h: {
    ship: number;
    review: number;
    noise: number;
    harmful: number;
    total: number;
  };
  /**
   * Judge calls over the last 24h that produced NO real verdict - a parse
   * failure (unparseable LLM response, even after the one-shot retry) or a
   * network failure (the API call itself threw). judgeProposal() returns via
   * its `fallback()` helper BEFORE recordJudgeTrace() runs on either path
   * (see fleet/manager.ts), so these calls write no judge-trace row and are
   * invisible to judgeVerdicts24h - without this field a failed judge call
   * looks identical to a judge call that never happened.
   *
   * Sourced from the decisions ledger's distinct 'judge-parse-failure' /
   * 'judge-network-failure' judgeReasonCode (fleet/judge-decision-metadata.ts),
   * NOT from judge-trace - fallback verdicts are deliberately never written
   * to judge-trace because their synthetic all-3 scores would corrupt
   * judge-calibration.ts (darkCurrent/kappa/degradation-harness all read
   * every trace unconditionally). The decisions ledger already records both
   * failure kinds distinctly and separately from calibration's read path.
   */
  judgeFailures24h: {
    parse: number;
    network: number;
    total: number;
  };
  /** Auto-merges today: proposals that reached status 'applied' today. */
  autoMergesToday: {
    count: number;
    /** Titles of the most-recent merged proposals (cap 5). */
    titles: string[];
  };
  /** Active goals with their milestone progress (so you can see planner expansion). */
  activeGoals: {
    goalId: string;
    objective: string;
    totalMilestones: number;
    doneMilestones: number;
  }[];
  /**
   * Ships-per-day trend: count of 'applied' proposals for each of the last 7
   * calendar days, oldest-first. Empty when no data. Length <= 7.
   */
  shipsPerDayTrend: { date: string; count: number }[];
}

/**
 * M242: Fleet intelligence summary - shows the fleet learning about itself.
 * All fields are READ-ONLY aggregations from the decisions ledger, genome hub,
 * and worked ledger. Never carries secrets. Absent on pre-M242 snapshots.
 */
export interface IntelligenceSummary {
  /** ISO timestamp this summary was built. */
  generatedAt: string;
  /**
   * M240: Per-(engine, model, taskClass) learned routing scores.
   * Each entry shows the historical ship-rate and sample count for one
   * engine+model combination across all task classes seen in the ledger.
   */
  routingScores: {
    /** Composite key: `<engine>:<model>` or `<engine>` when model is absent. */
    key: string;
    engine: string;
    model: string | null;
    taskClass: string;
    /** Ship-rate in [0,1]. 0.5 = neutral / cold-start. */
    score: number;
    /** Recency-weighted sample count. */
    samples: number;
    /** Operational trend, or observational when authority is inactive. */
    trend: 'promoted' | 'demoted' | 'neutral' | 'observational';
  }[];
  /**
   * M235: Recent anti-playbook lessons written from judge rejections.
   * Each entry is a genome hub entry tagged 'm235:anti-playbook'.
   */
  antiPlaybooks: {
    id: string;
    title: string;
    /** First 200 chars of the lesson text. */
    snippet: string;
    ts: string;
  }[];
  /**
   * Per-engine scorecard derived from decisions ledger (24h window).
   * Aggregates ship/review/noise/harmful counts and ship-rate per engine.
   */
  engineScorecards: {
    engine: string;
    ship: number;
    review: number;
    noise: number;
    harmful: number;
    total: number;
    /** Ship-rate = ship / total. 0 when total === 0. */
    shipRate: number;
  }[];
  /**
   * M241: Recent fleet lifecycle events (last 20, newest-first).
   * Sourced from the decisions ledger 'event-bus' action entries.
   */
  recentEvents: {
    kind: string;
    detail: string;
    ts: string;
  }[];
  /**
   * M246: Cache hit rate across all decisions in the current window.
   * cacheRead / (tokensIn + cacheRead). 0 when unavailable or div-by-zero.
   */
  cacheHitRate?: number;
  /**
   * M246: Token consumption bucketed by engine tier.
   * Aggregated from the decisions ledger costUsd/tokensIn/tokensOut fields.
   */
  tokensByTier?: {
    frontier: number;
    mid: number;
    local: number;
  };
}

/**
 * The selectable tabs of the interactive TUI dashboard.
 *
 * M29 adds 'portfolio' - a READ-ONLY org-level surface rendered from the
 * optional `DashboardSnapshot.portfolio` section (health summary, in-flight
 * goals, top backlog, cost+forecast, effectiveness headline, and a "today"
 * delta block). The tab renders nothing destructive; it only displays the
 * already-aggregated read-only snapshot.
 */
export type TuiTab = 'overview' | 'runs' | 'swarms' | 'pulse' | 'mcp' | 'inbox' | 'portfolio';
