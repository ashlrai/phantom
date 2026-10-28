/** Shared goals contracts. Public entry point: ../types.ts. */
import type { ProviderInferenceQuotaSession, RunBudget } from './run.js';

// ---------------------------------------------------------------------------
// M28: GOAL PLANNING & SCHEDULING - `ashlr goals` (Ashlr v2 pillar F).
//
// SAFE BY CONSTRUCTION. M28 is the PLANNING + TRACKING + SCHEDULING layer on
// top of the already-safe execution path. It introduces NO new outward
// authority. A high-level OBJECTIVE (Goal) is decomposed into ordered
// MILESTONES; each milestone authors/links a versioned SpecArtifact and is
// advanced via the EXACT M21/M24 pattern - runSwarm with
// { sandbox:true, requireSandbox:true, propose:true } + a hard budget, gated
// by assertMayMutate(repo). A goal can NEVER mutate a real working tree, push,
// open a PR, or deploy - its ONLY execution sink is a PENDING inbox proposal a
// human approves later. Planning/tracking writes ONLY under ~/.ashlr/goals/.
// These types carry METADATA ONLY - never secret values.
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a single Milestone.
 *  - 'pending'     : not yet advanced; eligible to be the next actionable one.
 *  - 'in-progress' : a sandboxed, proposal-only swarm is currently running.
 *  - 'proposed'    : the swarm produced a PENDING inbox proposal (linked via
 *                    proposalId). This is the terminal "success" state M28
 *                    drives to - a human approves the proposal out-of-band.
 *  - 'paused'      : the human paused this milestone; it is skipped by
 *                    nextActionableMilestone() until resumed.
 *  - 'skipped'     : the human skipped this milestone permanently.
 *  - 'blocked'     : an advance attempt failed/escalated (swarm 'failed' /
 *                    'aborted' / 'needs-approval'); requires human attention.
 *  - 'done'        : the milestone's proposal has a verified realized merge, or a human completed it
 *                    (set by a read-only reconcile against inbox state, never
 *                    by M28 mutating the proposal itself).
 */
export type MilestoneStatus =
  | 'pending'
  | 'in-progress'
  | 'proposed'
  | 'paused'
  | 'skipped'
  | 'blocked'
  | 'done';

/**
 * Lifecycle status of a whole Goal (objective). Derived/rolled-up from its
 * milestones by progressOf(), but persisted for cheap listing.
 *  - 'planning'  : created; milestones not yet decomposed (no plan yet).
 *  - 'active'    : has milestones; at least one is pending/in-progress.
 *  - 'paused'    : the human paused the entire goal (no milestone advances).
 *  - 'done'      : every non-skipped milestone is 'done'.
 *  - 'archived'  : the human retired the goal (read-only henceforth).
 */
export type GoalStatus = 'planning' | 'active' | 'paused' | 'done' | 'archived';

/** Immutable planning provenance for a goal materialized from a mission graph. */
export interface GoalMissionBindingV1 {
  schemaVersion: 1;
  graphDigest: string;
  missionKey: string;
  nodeKey: string;
}

/** Immutable provenance for a Goal materialized by the durable outcome coordinator.
 * A binding identifies scope and node basis; it never grants provider/merge authority. */
export interface GoalOutcomeBindingV1 {
  schemaVersion: 1;
  outcomeId: string;
  nodeId: string;
  nodeBasisDigest: string;
  scopeRevision: number;
  scopeDigest: string;
}

/**
 * M28: a single MILESTONE within a Goal. Each milestone is an ordered unit of
 * work that authors/links a versioned SpecArtifact and is advanced by a single
 * sandboxed, proposal-only swarm. Milestones are TRACKED over time and the
 * human STEERS them (reorder/pause/skip). METADATA ONLY - no secrets.
 */
export interface Milestone {
  /** Stable, deterministic milestone id (unique within its Goal). */
  id: string;
  /** Short human-readable title (the decomposed sub-objective). */
  title: string;
  /** Longer detail / acceptance hint for this milestone (no secrets). */
  detail: string;
  /** Explicit ordering key; lower = earlier. Reorder mutates these. */
  order: number;
  /** Current lifecycle status. Created as 'pending'. */
  status: MilestoneStatus;
  /**
   * Id of the versioned SpecArtifact this milestone authors/links (via
   * authorSpec), or null until `goals plan` has run. NEVER an outward action.
   */
  specId: string | null;
  /**
   * Id of the SwarmRun produced by the most recent advance of this milestone,
   * or null if never advanced. READ-ONLY tracking handle (loadSwarm(swarmId)).
   */
  swarmId: string | null;
  /**
   * Id of the PENDING inbox Proposal the swarm emitted (its ONLY execution
   * sink), or null. READ-ONLY tracking handle (loadProposal(proposalId)). M28
   * NEVER approves/applies this proposal.
   */
  proposalId: string | null;
  /** ISO timestamp the milestone was created. */
  createdAt: string;
  /** ISO timestamp the milestone was last updated. */
  updatedAt: string;
}

/**
 * M28: a high-level OBJECTIVE the org decomposes into ordered Milestones.
 * Persisted one-file-per-goal at ~/.ashlr/goals/<id>.json (atomic JSON, mirror
 * of the learn/quality stores). PLANNING + TRACKING data only - creating or
 * editing a Goal NEVER touches a user repo, never runs a swarm, and never
 * emits an outward action. METADATA ONLY - no secrets.
 */
export interface Goal {
  /** Stable unique id; also the file stem (~/.ashlr/goals/<id>.json). */
  id: string;
  /**
   * M109: The user identity that created this goal (cfg.user?.id ?? cfg.user?.name).
   * Undefined when cfg.user is absent → no behavior change; backward-compatible.
   * Carried in OTLP spans as `ashlr.fleet.owner` for pulse team attribution.
   */
  owner?: string;
  /** Exact graph/node contract that created this goal; absent on legacy goals. */
  mission?: GoalMissionBindingV1;
  outcome?: GoalOutcomeBindingV1;
  /** The high-level objective text the goal was created from. */
  objective: string;
  /**
   * Absolute path of the ENROLLED repo this goal is bound to, or null when the
   * goal is repo-agnostic (planning-only; cannot be advanced). When set, it
   * MUST be filtered through isEnrolled() (resolve() first) at BOTH the core
   * advance path and the CLI before any swarm starts.
   */
  project: string | null;
  /** Rolled-up lifecycle status. Created as 'planning'. */
  status: GoalStatus;
  /** Ordered milestones (sorted by `order`). Empty until `goals plan` runs. */
  milestones: Milestone[];
  /** ISO timestamp the goal was created. */
  createdAt: string;
  /** ISO timestamp the goal was last updated. */
  updatedAt: string;
}

/**
 * M28: options for the deterministic-by-default decomposition of an objective
 * into Milestones (planner.decomposeGoal). LOCAL-FIRST: no model is used unless
 * `allowCloud` opens the local-first provider chain (Ollama/LM Studio only
 * unless a cloud key is configured). BOUNDED by `maxMilestones`.
 */
export interface DecomposeOptions {
  /**
   * Permit an optional LLM-assisted refinement of the deterministic split,
   * routed through getActiveClient(cfg, { allowCloud }). Default false =
   * deterministic, local-only, ZERO non-localhost connections.
   */
  allowCloud?: boolean;
  /** Hard cap on how many milestones to produce (bounds the plan). */
  maxMilestones?: number;
}

/**
 * M28: options for advancing a single milestone (advance.advanceGoal). The
 * advance ALWAYS runs runSwarm with { sandbox:true, requireSandbox:true,
 * propose:true } - these are NOT configurable here; only the bound/test-seam
 * knobs below are exposed.
 */
export interface AdvanceOptions {
  /**
   * Partial budget override merged over the M28 default HARD per-advance
   * ceiling. The advance NEVER runs unbounded.
   */
  budget?: Partial<RunBudget>;
  /**
   * Permit a CLOUD model inside the advanced swarm (default false =
   * local-first). Threaded into SwarmOptions.allowCloud only.
   */
  allowCloud?: boolean;
  /**
   * TEST SEAM only - forwarded to assertMayMutate(repo, { allowAnyRepo }) so
   * tests can advance a goal bound to a tmp repo without enrolling it. NEVER
   * bypasses the kill switch. Defaults to undefined (real enrollment enforced).
   *
   * HARDENED (M28 final fix): advanceGoal honors this ONLY when the process
   * ALSO sets the env var ASHLR_TEST_ALLOW_ANY_REPO=1. A production / in-process
   * caller passing { allowAnyRepo: true } WITHOUT that env var CANNOT bypass the
   * enrollment check - so enrollment-scoping (invariant #2) holds on every
   * shipped codepath. It also never reaches the runner, which re-enforces
   * enrollment at swarm start regardless.
   */
  allowAnyRepo?: boolean;
  /**
   * Optional fail-closed CAS binding used only by the signed one-shot goal
   * conductor. When either field is present, both are required and the exact
   * goal generation is atomically claimed before provider execution.
   */
  expectedGoalDigest?: string;
  expectedMilestoneId?: string;
  /**
   * Signed one-shot provider authority. Its opaque attempt id becomes the
   * swarm run id and its synchronous claim function is carried to every model
   * call without ever being serialized.
   */
  providerQuota?: ProviderInferenceQuotaSession;
}

/**
 * M28: read-only roll-up of a Goal's progress (progressOf). Pure analysis over
 * the goal record + swarm/inbox state - mutates NOTHING. METADATA ONLY.
 */
export interface GoalProgress {
  /** The goal id this roll-up describes. */
  goalId: string;
  /** Total milestone count. */
  total: number;
  /** Count of milestones in each status (sparse - only non-zero keys present). */
  byStatus: Partial<Record<MilestoneStatus, number>>;
  /** Count of milestones that have produced a PENDING proposal ('proposed'). */
  proposed: number;
  /** Count of milestones fully 'done'. */
  done: number;
  /** Fraction complete (done / (total - skipped)), 0..1; 0 when nothing to do. */
  fractionDone: number;
  /**
   * The next actionable milestone id (the lowest-order 'pending' milestone when
   * the goal is not paused), or null when there is nothing to advance.
   */
  nextActionableId: string | null;
}
