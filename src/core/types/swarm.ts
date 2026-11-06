/** Shared swarm contracts. Public entry point: ../types.ts. */
import type { WorkSource } from './backlog.js';
import type { DelegationScope } from './delegation.js';
import type { ProviderInferenceQuotaSession, RunBudget, RunProposalOutcome, RunUsage } from './run.js';

// ---------------------------------------------------------------------------
// M12: contracts-first swarm - end-state specs (`ashlr spec`) + fleet runner
// (`ashlr swarm`). Specs are first-class versioned artifacts; a swarm
// decomposes a spec into a contracts-first DAG of phases and runs a bounded
// fleet of local-first agents through them.
// ---------------------------------------------------------------------------

/**
 * A first-class, versioned END-STATE SPEC artifact. The markdown body lives at
 * <project>/.ashlr/specs/<slug>-v<N>.md with this sidecar metadata alongside
 * it as <slug>-v<N>.json. Versioning is never destructive: refining produces
 * a new version (v+1) rather than overwriting.
 */
export interface SpecArtifact {
  /** Stable spec id (slug derived from the goal; shared across versions). */
  id: string;
  /** The original authoring goal/prompt for the spec. */
  goal: string;
  /** Monotonic version number (1-based; refine produces v+1). */
  version: number;
  /** Absolute project path the spec is scoped to, or null when global. */
  project: string | null;
  /** Absolute path to the markdown body file for this version. */
  path: string;
  /** Lifecycle status of the spec. */
  status: 'draft' | 'active' | 'archived';
  /** ISO timestamp the spec (this version) was created. */
  createdAt: string;
  /** ISO timestamp the spec was last updated. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// M17: verified + unattended-safe swarms - signing, escalation, rollback.
// ---------------------------------------------------------------------------

/**
 * Tamper-evident signature over a swarm task's output.
 * Contains ONLY hashes - never any payload secret. `hash` is a content digest
 * of the signed text; `sig` is the keyed signature. `hmac-sha256` uses the
 * local auto-generated key. `phantom` is reserved for legacy/future records
 * backed by a real Phantom-held signing primitive and must fail closed unless
 * that primitive is available.
 */
export interface OutputSignature {
  /** Signing algorithm / key source. */
  alg: 'hmac-sha256' | 'phantom';
  /** Content digest (hex) of the signed text. */
  hash: string;
  /** Keyed signature (hex) over the content. NEVER a secret value. */
  sig: string;
  /** Opaque signer identity (e.g. 'local' or a phantom key id) - no secrets. */
  signer: string;
  /** ISO timestamp the signature was produced. */
  ts: string;
}

/** Why a swarm escalation gate tripped. */
export type EscalationReasonKind =
  | 'verify-failed'
  | 'over-budget'
  | 'tamper'
  | 'risk'
  | 'low-confidence';

/**
 * A single escalation gate trip. The swarm persists this and STOPS
 * (status 'needs-approval'); only an explicit `ashlr swarm approve <id>` resumes.
 */
export interface EscalationEvent {
  /** Task that triggered the gate, or null for swarm-level (e.g. over-budget). */
  taskId: string | null;
  /** Which gate tripped. */
  kind: EscalationReasonKind;
  /** Human-readable explanation (no secrets). */
  detail: string;
  /** ISO timestamp the gate tripped. */
  ts: string;
}

/**
 * Read-only git snapshot of a project, taken before a swarm operates in it.
 * Used by the CONFIRM-gated `ashlr swarm rollback <id>`. NEVER carries secrets.
 */
export interface RollbackSnapshot {
  /** Absolute project path, or null when the swarm has no project. */
  project: string | null;
  /** Whether `project` is a git repository. */
  isRepo: boolean;
  /** Recorded HEAD commit sha, or null when not a repo / unresolved. */
  head: string | null;
  /**
   * Branch name HEAD pointed at when the snapshot was taken, or null when HEAD
   * was already detached / unresolved. Used so a non-force rollback can return
   * the repo to the original branch rather than leaving it in detached HEAD.
   */
  branch?: string | null;
  /** Whether the working tree was dirty at snapshot time. */
  dirty: boolean;
  /** Ref/name of the stash holding the dirty tree, or null when clean/none. */
  stashRef: string | null;
  /** ISO timestamp the snapshot was taken. */
  ts: string;
}

/** The ordered phases of a contracts-first swarm. */
export type SwarmPhaseName = 'scaffold' | 'build' | 'integrate' | 'verify' | 'review';

/** A single planned task within a swarm phase (a unit of agent work). */
export interface SwarmTaskSpec {
  /** Stable task id (unique within the swarm). */
  id: string;
  /** Which phase this task belongs to. */
  phase: SwarmPhaseName;
  /** The sub-goal this task must accomplish. */
  goal: string;
  /** Ids of tasks that must complete before this one runs. */
  deps: string[];
}

/** Execution state of a single swarm task. */
export interface SwarmTaskRun {
  /** Stable task id (matches its SwarmTaskSpec.id). */
  id: string;
  /** Which phase this task belongs to. */
  phase: SwarmPhaseName;
  /** Current lifecycle status. */
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
  /** Final task result text, present when done. */
  result?: string;
  /** Token/step usage attributed to this task. */
  usage?: RunUsage;
  /** Failure reason when status is 'failed', else absent. */
  error?: string;
  /**
   * M17: tamper-evident signature over this task's `result`, computed when the
   * task completes. Downstream tasks verify this before consuming the output.
   */
  signature?: OutputSignature;
  /**
   * M17: set true when a human explicitly approved this task past an escalation
   * gate via `ashlr swarm approve <id>`. The runner SKIPS re-scanning this
   * task's goal-risk on the resumed run so an approved goal-risk escalation
   * does not re-trip the same gate and loop forever. Cleared/absent otherwise.
   */
  approved?: boolean;
}

/** The planned swarm: a decomposition of a goal/spec into phased tasks. */
export interface SwarmPlan {
  /** Source spec id this plan derives from, or null when goal-only. */
  specId: string | null;
  /** The top-level goal the swarm pursues. */
  goal: string;
  /** All planned tasks across phases (caps tasks per phase <= 6). */
  tasks: SwarmTaskSpec[];
  /** Exact provider token accounting when the planner returned it. */
  usage?: Pick<RunUsage, 'tokensIn' | 'tokensOut'>;
}

/** Full persisted state of a swarm. Lives at ~/.ashlr/swarms/<id>.json. */
export interface SwarmRun {
  /** Stable swarm id. */
  id: string;
  /** The original top-level goal. */
  goal: string;
  /** Source spec id, or null when goal-only. */
  specId: string | null;
  /** Absolute project path the swarm operates in, or null. */
  project: string | null;
  /** Durable causal item identity restored across worker and CLI resume boundaries. */
  workItemId?: string;
  /** Immutable generated-repair generation hash restored on resume. */
  workItemGenerationId?: string;
  /** Durable scanner/source identity restored on resume. */
  workSource?: WorkSource;
  /** Execution flags required to resume a sandboxed proposal run faithfully. */
  resumeOptions?: {
    sandbox?: true;
    requireSandbox?: true;
    propose?: true;
    noCapture?: true;
    /** Detached launcher persisted a claimed-authority handoff for its worker. */
    backgroundHandoff?: true;
  };
  /** ISO timestamp the swarm was created. */
  createdAt: string;
  /** ISO timestamp of the last update (written after each step). */
  updatedAt: string;
  /** HARD total guardrails in effect across the whole swarm. */
  budget: RunBudget;
  /** Cumulative usage across all tasks (sum of per-task usage). */
  usage: RunUsage;
  /** Bounded concurrency for the parallel BUILD phase. */
  parallel: number;
  /**
   * Current swarm status. M17 adds 'needs-approval': the swarm PAUSED at an
   * escalation gate and STOPPED; an explicit `ashlr swarm approve <id>` resumes it.
   */
  status: 'planning' | 'running' | 'done' | 'aborted' | 'failed' | 'needs-approval';
  /** The planned decomposition. */
  plan: SwarmPlan;
  /** Per-task execution state, in plan order. */
  tasks: SwarmTaskRun[];
  /** Aggregated final result/summary, present when done. */
  result?: string;
  /** Metadata-only reason the sandboxed swarm did or did not file a proposal. */
  proposalOutcome?: RunProposalOutcome;
  /**
   * M17: ordered log of escalation gate trips. Each entry records why the swarm
   * paused (verify-failed, over-budget, tamper, risk, low-confidence). Append-only.
   */
  escalations?: EscalationEvent[];
  /**
   * M17: read-only git snapshot of the project taken before the swarm operated
   * in it. Drives the CONFIRM-gated `ashlr swarm rollback <id>`. Absent if the
   * swarm has no project or the project is not a git repo.
   */
  rollback?: RollbackSnapshot;
}

/** Options accepted by `runSwarm` / the `ashlr swarm` CLI. */
export interface SwarmOptions {
  /** Nonserializable caller outcome revision, shared by planner and every child. */
  selectedOutcomeAdmission?: () => boolean;
  /** Optional owner cancellation shared by planning and every task run. */
  signal?: AbortSignal;
  /** Partial budget overrides (merged over defaults) - the HARD total ceiling. */
  budget?: Partial<RunBudget>;
  /** Positive safe-integer BUILD concurrency preference (default 3); actual tasks/budget still bind. */
  parallel?: number;
  /** Launch a detached background worker and return the swarm id immediately. */
  background?: boolean;
  /** Existing swarm id to resume from persisted state. */
  resumeId?: string;
  /** Caller-preallocated opaque id for a fresh swarm; ignored when resumeId is set. */
  runId?: string;
  /** Optional advisory delegation contract inherited by swarm tasks. */
  delegationScope?: DelegationScope;
  /** Plan only - produce the SwarmPlan without executing any task. */
  dryRun?: boolean;
  /** Permit cloud providers for tasks (default false = local-first). */
  allowCloud?: boolean;
  /** Disable post-swarm and nested-run genome capture. */
  noCapture?: boolean;
  /**
   * Non-serializable, caller-owned authority shared by swarm planning and all
   * nested builtin runs. It is deliberately excluded from persisted resume
   * options, so signed one-shot authority can never be revived from disk.
   */
  providerQuota?: ProviderInferenceQuotaSession;
  /** Absolute target project directory the swarm operates in. */
  project?: string;
  /**
   * M17: when set alongside resumeId, resumes a swarm paused in 'needs-approval'
   * - set ONLY by `ashlr swarm approve <id>` (explicit human action). Threads the
   * approval into the runner so a goal-risk escalation can actually be cleared
   * (the runner skips re-scanning approved tasks). Never set on a fresh run.
   */
  approved?: boolean;
  /**
   * M21: when true, the swarm runs inside an isolated git-worktree sandbox
   * (created under ~/.ashlr/sandboxes/) instead of the user's working tree.
   * SEAM ONLY - plumbed here so a future daemon (M24) can wire it; defaults to
   * OFF, in which case the swarm behaves exactly as it does today.
   */
  sandbox?: boolean;
  /**
   * M24: when true (alongside sandbox), the swarm's captured patch is recorded
   * as a PENDING inbox proposal rather than left as a bare worktree diff. SEAM
   * ONLY - grants NO outward authority: a PENDING proposal is applied LATER only
   * by an explicit human `inbox approve`. Defaults to OFF.
   */
  propose?: boolean;
  /**
   * M24: when true (alongside sandbox), the sandbox is MANDATORY - if the
   * isolated git-worktree cannot be created (worktree module absent, source is
   * not a git repo, HEAD unresolvable, `git worktree add` fails, or a kill-switch
   * race), the swarm ABORTS with status 'failed' and executes ZERO tasks rather
   * than silently falling back to the user's working tree. The autonomous daemon
   * ALWAYS sets this so its work can NEVER touch a real repo's working tree.
   * Defaults to OFF (preserves the legacy non-strict fallback for non-daemon callers).
   */
  requireSandbox?: boolean;
  /** Optional originating backlog/work item id for causal tracing. */
  workItemId?: string;
  /** Hash binding generated repair proposals to one immutable source generation. */
  workItemGenerationId?: string;
  /** Optional originating backlog scanner/source for causal tracing. */
  workSource?: WorkSource;
}
