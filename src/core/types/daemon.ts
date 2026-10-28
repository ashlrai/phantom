/** Shared daemon contracts. Public entry point: ../types.ts. */
import type { WorkItem } from './backlog.js';
import type { EngineId, EngineTier } from './engines.js';
import type { EvidenceOutcomeSummary, LabelBasis, LearningSource, RouteSnapshot, RunEventSummary } from './learning.js';

// ---------------------------------------------------------------------------
// M24: THE DAEMON - the autonomous operator.
//
// SAFE BY CONSTRUCTION. The daemon's ONLY output is PENDING proposals in the
// M23 approval inbox. It NEVER applies/approves a proposal, NEVER pushes, NEVER
// opens a PR, NEVER deploys, NEVER mutates a user repo working tree. It operates
// ONLY on listEnrolled() repos (DEFAULT EMPTY => it does nothing), all work runs
// SANDBOXED (M21 worktrees), and it is BOUNDED by a hard daily budget cap + a
// per-tick item cap + a concurrency cap, halted instantly by the kill switch.
// These types carry METADATA ONLY - never secret values.
// ---------------------------------------------------------------------------

/**
 * M24: bounding configuration for the autonomous operator. Every field caps HOW
 * MUCH the daemon may propose - none of them grant any outward authority (the
 * daemon is proposal-only by construction). Sourced from cfg.daemon (partial),
 * merged over conservative hard-coded defaults.
 */
export interface DaemonConfig {
  /** Request macOS idle/system sleep inhibition on AC while the resident launchd service runs. Requires a confirmed service restart. */
  keepAwake?: boolean;
  /** HARD daily spend ceiling (USD). When today's spend reaches it, the daemon
   *  idles/stops. Resets per calendar day. Default modest. */
  dailyBudgetUsd: number;
  /** Positive safe integer token allowance for proven zero-dollar producers; defaults to the normal run allowance. */
  perItemMaxTokens?: number;
  /** Per-tick item preference; null uses eligible inventory within actual admission. Absent defaults to 3. */
  perTickItems: number | null;
  /** Batch concurrency preference; null has no operator ceiling. Absent defaults to 2. */
  parallel: number | null;
  /** Interval between ticks in `daemon start` loop mode (ms). */
  intervalMs: number;
  /**
   * M116: daemon execution mode.
   * 'batch'      - (default) process one fixed batch per interval, then sleep
   *                intervalMs. Byte-identical to pre-M116 behavior.
   * 'continuous' - keep dispatching back-to-back: as soon as a worker slot frees,
   *                claim + dispatch the next item. Only backs off (idleBackoffMs)
   *                when the backlog is empty. Bound by budget + kill-switch + pool caps.
   */
  mode?: 'batch' | 'continuous';
  /** Continuous count preference. Explicit null overrides total with no operator
   * ceiling; absent inherits concurrency.total (default 8). Actual admission remains. */
  maxConcurrent?: number | null;
  /** Per-tier preferences: absence retains local2/cloud6/total8, null removes
   * only the operator ceiling. maxConcurrent, including null, overrides total. */
  concurrency?: {
    local?: number | null;
    cloud?: number | null;
    total?: number | null;
  };
  /**
   * M116: how long (ms) the continuous loop backs off when the backlog is empty
   * before re-checking. Default 5 000 ms. Only used in continuous mode.
   */
  idleBackoffMs?: number;
  /**
   * Lane-specific one-shot drain caps. These bound repair drains separately
   * from normal production velocity so targeted maintenance cannot consume every
   * available worker slot just because the machine has capacity.
   */
  drainLimits?: {
    diagnosticReslices?: number;
  };
  /**
   * Metadata-only context rollup emitted after a durable live tick. This never
   * invokes a model or mutates genome memory, routing, proposals, or merge state.
   */
  contextRollup?: {
    /** Enabled by default; set false to suppress autonomous rollup telemetry. */
    enabled?: boolean;
    /** Minimum hours between persisted rollup events. Default 24, floor 1. */
    cadenceHours?: number;
    /** Minimum unique terminal trajectories required for a rollup. Default 50, floor 25. */
    minTerminalTrajectories?: number;
  };
  /**
   * Default-off, observation-only Agent OS snapshot compiler. Public keys are
   * configuration, never effect authority; an empty/invalid policy fails closed.
   */
  agentOsObserver?: {
    /** Exact opt-in. Absent/false schedules no child and performs no reads. */
    enabled?: boolean;
    /** Per-attempt wall-clock deadline. Runtime bounds this to 100..30000 ms. */
    deadlineMs?: number;
    /** Dedicated Ed25519 observation trust roots; never activation credentials. */
    trustPolicy?: import('../vision/agent-os-source-bundle.js').AgentOsSourceTrustPolicyV1;
  };
}

/**
 * M24: the record of a single operator cycle (one `tick`). Pure accounting of
 * what was considered + proposed + spent. Creating a tick NEVER applies anything.
 */
export interface DaemonDispatchTrace {
  /** Work item id considered by this tick. */
  itemId: string;
  /** Bounded human-readable title for dashboard display. */
  title: string;
  /** Repository path for the item. */
  repo: string;
  /** Original backlog source. */
  source: WorkItem['source'];
  /** Final backend selected for this item, or null when skipped before routing. */
  backend: EngineId | null;
  /** Final engine tier, or null when skipped before routing. */
  tier: EngineTier | null;
  /** Model selected by routing, when known. */
  model?: string | null;
  /** Which routing path made or overrode the assignment. */
  assignedBy: string;
  /** Short routing/skip reason suitable for logs and dashboards. */
  reason: string;
  /** True only when an engine/swarm was actually invoked. */
  dispatched: boolean;
  /** Estimated USD spent by this item dispatch. */
  spentUsd: number;
  /** Opaque run/swarm id allocated before execution, including terminal failures. */
  runId?: string;
  /** Stable attempt/work trajectory id for joining dispatch, proposal, and decision rows. */
  trajectoryId?: string;
  /** Metadata-only route snapshot; never includes prompts or engine output. */
  routeSnapshot?: RouteSnapshot;
  /** Metadata-only run summary; never includes prompts, diffs, stdout, or stderr. */
  runEventSummary?: RunEventSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  /** Skip/error reason when no engine was invoked or dispatch failed. */
  skipReason?: string;
  /** Terminal proposal-production outcome for dispatched work, when known. */
  production?: DaemonDispatchProduction;
}

export type DaemonDispatchProductionOutcome =
  | 'proposal-created'
  | 'cancelled'
  | 'empty-diff'
  | 'gate-blocked'
  | 'engine-failed'
  | 'sandbox-failed'
  | 'proposal-capture-error'
  | 'proposal-disabled'
  | 'shadow-observation'
  | 'unknown';

export interface DaemonDispatchProduction {
  outcome: DaemonDispatchProductionOutcome;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  reason?: string;
  diffFiles?: number;
  diffLines?: number;
}

export interface DaemonProposalProductionReason {
  /** Bounded routing, skip, or error reason. */
  reason: string;
  /** Number of item outcomes with this reason. */
  count: number;
}

export interface DaemonProposalProductionSummary {
  /** Backlog items selected after scoring, pending-proposal dedupe, and budget caps. */
  selected: number;
  /** Items successfully claimed from the work queue coordinator. */
  claimed: number;
  /** Items whose engine/swarm path was actually invoked. */
  dispatched: number;
  /** Claimed item outcomes skipped before engine invocation. */
  skipped: number;
  /** Dispatch tasks that rejected outside normal per-item handling. */
  errors: number;
  /** PENDING proposals created by the tick, measured by inbox delta. */
  proposalsCreated: number;
  /** Batch-level signal: dispatched items minus created proposals, clamped to >= 0. */
  noProposalDispatches: number;
  /** Top bounded reasons explaining dispatch, skip, or error outcomes. */
  reasons?: DaemonProposalProductionReason[];
}

export interface DaemonDispatchManifestSummary {
  schemaVersion: 1;
  manifestId: string;
  ts: string;
  mode: 'concurrent';
  recorded: boolean;
  claimed: number;
  assigned: number;
  unassigned: number;
  backends: Record<string, number>;
  resourceSnapshotAt?: string;
}

export type DaemonDrainMode = 'diagnostic-reslices';

export interface DaemonDrainSummary {
  /** Targeted drain lane requested for this tick. */
  mode: DaemonDrainMode;
  /** Matching lane items visible before cooldown/pending/claim gates. */
  available: number;
  /** Matching lane items selected/claimed for this tick. */
  selected: number;
  /** Effective lane cap applied after normal daemon budget/resource caps. */
  limit?: number;
  /** True when visible lane work exceeded the effective lane cap. */
  capped?: boolean;
  /** True when the daemon selected this lane automatically during a normal live tick. */
  automatic?: boolean;
  /** Bounded selected work ids, used to prove the drain lane actually ran. */
  selectedItemIds?: string[];
  /** True when the lane had visible work but selected nothing. */
  stalled?: boolean;
  /** True when one-slot temporal fairness intentionally yielded to ordinary work. */
  fairnessDeferred?: boolean;
}

export interface DaemonTick {
  /** ISO timestamp the tick ran. */
  ts: string;
  /** Exact persisted backlog generation produced by this tick, when refreshed. */
  backlogSnapshotAt?: string;
  /** Exact random backlog snapshot identity produced by this tick. */
  backlogSnapshotId?: string;
  /**
   * M334: wall-clock duration of this tick (ms). The CONTRACT-M334 stage-2
   * soak instrument - compare p50/p95 before/after enabling concurrent
   * dispatch. Recorded by the recordTick funnel; absent on pre-M334 records.
   */
  durationMs?: number;
  /** How many backlog items were considered (post budget/cap selection). */
  itemsConsidered: number;
  /** How many PENDING proposals this tick created in the inbox. */
  proposalsCreated: number;
  /** Estimated USD spent during this tick. */
  spentUsd: number;
  /** Why the tick did what it did (e.g. 'ok', 'kill-switch', 'budget-exhausted',
   *  'no-enrolled-repos', 'no-backlog', 'dry-run'). */
  reason: string;
  /** A treatment-only persistence failure safe for the resident loop; any later daemon persistence failure strips this flag. */
  residentSafePersistenceFailure?: 'repair-treatment';
  /** True when this tick was produced by a dry-run/simulation path. */
  dryRun?: boolean;
  /** M48: per-backend dispatch counts this tick (e.g. {builtin:2, claude:1}). */
  backends?: Record<string, number>;
  /** M308: resource-aware direction mode applied to this tick when opt-in. */
  directionMode?: 'pause' | 'local-only' | 'verify-only' | 'backlog-build' | 'auto-merge-ready';
  /** M308: one-line reason behind the applied autonomy direction. */
  directionReason?: string;
  /** M308/M48: maintenance work performed by the auto-merge pass this tick. */
  autoMerge?: {
    attempted: number;
    judgePerPass?: number;
    judged: number;
	    judgeCapped?: number;
	    verifyBeforeJudgePerPass?: number;
	    verifyBeforeJudgeRan?: number;
	    verifyBeforeJudgeCapped?: number;
    judgeEstimatedSpendUsd?: number;
    merged: number;
    handoffs?: number;
    autoArchived?: number;
	    ttlRejected?: number;
	    invalidRejected?: number;
	  };
  /** Remote host PR handoff reconciliation performed this tick. */
  remoteHandoff?: {
    checked: number;
    merged: number;
    closed: number;
    open: number;
    unknown: number;
  };
  /** M313: producer maintenance attempted during this tick. Metadata-only. */
  producerMaintenance?: {
    selfHeal: boolean;
    invent: boolean;
    ancillary: boolean;
    proposalRepair?: boolean;
    proposalRepairEligible?: number;
    proposalRepairQueued?: number;
    proposalRepairFailed?: number;
    dispatchCaptureRepairScanned?: number;
    dispatchCaptureRepairEligible?: number;
    dispatchCaptureRepairQueued?: number;
    dispatchCaptureRepairFailed?: number;
    dispatchNoDiffResliceScanned?: number;
    dispatchNoDiffResliceEligible?: number;
    dispatchNoDiffResliceQueued?: number;
    dispatchNoDiffResliceFailed?: number;
    dispatchRepairRetired?: number;
    dispatchRepairExhausted?: number;
    dispatchRepairQuarantined?: number;
    dispatchRepairPruned?: number;
    dispatchRepairPruneFailed?: number;
    dispatchRepairLifecycleUnavailable?: number;
    repairRootAdmissionConsidered?: number;
    repairRootAdmissionAdmitted?: number;
    repairRootAdmissionAlreadyActive?: number;
    repairRootAdmissionRootless?: number;
    repairRootAdmissionDepthRejected?: number;
    repairHandoffObservations?: number;
    repairHandoffInvalidRows?: number;
    repairHandoffConflictingIds?: number;
    repairHandoffSourceState?: 'missing' | 'healthy' | 'degraded';
    repairHandoffAuthorityDigest?: string;
    repairHandoffActivationId?: string;
    repairHandoffActivatedAt?: string;
    repairHandoffActivationAuthorities?: number;
    repairHandoffActivationAuthorityDigest?: string;
    repairHandoffCompacted?: number;
    repairHandoffCompactionUnavailable?: number;
    proposalRepairInboxAvailable?: boolean;
    diagnosticResliceParentsResolved?: number;
    diagnosticResliceParentsMissing?: number;
    /** M505 learning-loop sweep observability: rejection-learning pass. */
    rejectionLearningScanned?: number;
    rejectionLearningWritten?: number;
    rejectionLearningSkipped?: number;
    rejectionLearningSourceComplete?: boolean;
    /** M505 learning-loop sweep observability: post-merge-credit release pass. */
    postMergeCreditScanned?: number;
    postMergeCreditReleased?: number;
    postMergeCreditSkipped?: number;
    postMergeCreditSourceComplete?: boolean;
    skippedByCadence?: boolean;
    nextAfter?: string;
  };
  /** M314: machine-readable proposal production accounting for this tick. */
  proposalProduction?: DaemonProposalProductionSummary;
  /** Forensic dispatch intent recorded before concurrent execution starts. */
  dispatchManifest?: DaemonDispatchManifestSummary;
  /** Targeted drain accounting for lane-specific daemon ticks. */
  drain?: DaemonDrainSummary;
  /** Bounded per-item backend assignment traces for this tick. */
  dispatches?: DaemonDispatchTrace[];
  /** M48: proposals auto-merged this tick via the M47 gate (omitted/0 when disabled). */
  merged?: number;
}

/**
 * M24: persisted daemon state at ~/.ashlr/daemon.json. Tracks run/loop status,
 * today's spend (reset per day), cumulative items processed, and recent ticks.
 * METADATA ONLY - no secrets, no diffs. Mutating this NEVER mutates a user repo.
 */
export interface DaemonState {
  /** Ephemeral startup refusal returned to the caller; never persisted. */
  startRefusal?: string;
  /** Ephemeral fatal loop outcome used by service wrappers to request restart. */
  terminalFailure?: string;
  /** Whether the daemon loop is currently running. */
  running: boolean;
  /** OS pid of the running daemon process, or null when not running. */
  pid: number | null;
  /** ISO timestamp the current/last run started, or null. */
  startedAt: string | null;
  /** ISO timestamp of the most recent tick, or null. */
  lastTickAt: string | null;
  /** Calendar day (YYYY-MM-DD) the spend counters apply to; null until first tick. */
  todayDate: string | null;
  /** Estimated USD spent so far today; reset when todayDate rolls over. */
  todaySpentUsd: number;
  /** Cumulative count of backlog items processed across all ticks. */
  itemsProcessed: number;
  /**
   * Latest exact-once identity for a spend guard already charged to the
   * current UTC budget day. This is an accounting receipt only: it grants no
   * dispatch, proposal, verification, or merge authority.
   */
  spendGuardAccounting?: {
    budgetDay: string;
    accountingId: string;
    /** Unknown legacy exposure pessimistically closes this entire budget day. */
    budgetExhausted?: boolean;
  };
  /** Bounded history of recent ticks (most-recent last). */
  ticks: DaemonTick[];
  /** One-slot automatic drain owes the next contended turn to ordinary work. */
  automaticDrainOrdinaryTurnDue?: boolean;
  /**
   * M91: ISO timestamp of the last SUCCESSFUL fleet→pulse export.
   * Used as sinceTs watermark so each tick only re-sends new events.
   * Absent until the first successful POST. Never set on failure.
   */
  lastPulseExportAt?: string;
}
