/** Shared sandbox contracts. Public entry point: ../types.ts. */

// ---------------------------------------------------------------------------
// M21: the SAFETY FOUNDATION for the v2 Autonomous Engineering Org. ALL future
// autonomous code work happens in an ISOLATED git-worktree sandbox, is recorded
// in an append-only audit trail, is gated by per-repo enrollment + a global kill
// switch, and is bounded/killable. These types are the primitives M22–M30 build
// on. None of them carry secret values.
// ---------------------------------------------------------------------------

/**
 * M21: one isolated git-worktree sandbox of a source repo. Created under
 * ~/.ashlr/sandboxes/<id>/ on a NEW scratch branch off the source repo's
 * current HEAD, so autonomous edits NEVER touch the user's working tree, index,
 * HEAD, or their checked-out branch. Bounded - created, used, then discarded
 * (git worktree remove + scratch-branch delete). METADATA ONLY.
 */
export interface Sandbox {
  /** Opaque sandbox id; also the directory name under ~/.ashlr/sandboxes/. */
  id: string;
  /** Absolute path to the source repo this sandbox was forked from. */
  sourceRepo: string;
  /** Absolute path to the isolated worktree (~/.ashlr/sandboxes/<id>/). */
  worktreePath: string;
  /** Name of the scratch branch created for this sandbox (deleted on cleanup). */
  branch: string;
  /** The source repo HEAD commit the scratch branch was forked from. */
  baseHead: string;
  /** ISO timestamp the sandbox was created. */
  createdAt: string;
  /**
   * H5 - pid of the process that created this sandbox (a POSITIVE liveness
   * marker). The orphan sweep / disk-cap pre-sweep SKIP a sandbox whose
   * `ownerPid` is still alive (process.kill(pid,0) succeeds) regardless of age,
   * so a LIVE in-flight worktree is NEVER force-removed out from under a running
   * swarm - even a long-running cross-process one older than ORPHAN_STALE_MS.
   * Optional for back-compat: older metadata (and crash-simulation fixtures that
   * model a GONE owner) omit it, in which case the conservative createdAt-age
   * staleMs guard governs reclaim instead.
   */
  ownerPid?: number;
  /** Last bounded cleanup attempt retained only while recovery is incomplete. */
  cleanup?: SandboxCleanupEvidence;
  /**
   * Set (ISO time) when a failed creation could not roll its sandbox back and
   * gave it up: the sweeps then treat the owner as not live and reclaim it,
   * although `ownerPid` may still be running.
   */
  abandonedAt?: string;
}

export type SandboxCleanupPostcondition = 'absent' | 'present' | 'unknown' | 'unsafe';
export type SandboxCleanupFailureClass =
  | 'cleanup-locked'
  | 'unsafe-metadata'
  | 'source-repo-unavailable'
  | 'worktree-remaining'
  | 'branch-remaining'
  | 'postcondition-unavailable'
  | 'home-remove-failed';

export interface SandboxCleanupEvidence {
  schemaVersion: 1;
  attemptedAt: string;
  attempt: number;
  status: 'residual' | 'refused' | 'unavailable';
  postconditions: {
    registration: SandboxCleanupPostcondition;
    branch: SandboxCleanupPostcondition;
    home: SandboxCleanupPostcondition;
  };
  failureClasses: SandboxCleanupFailureClass[];
  retryable: boolean;
}

export interface SandboxCleanupResult {
  status: 'complete' | 'residual' | 'refused' | 'unavailable';
  postconditions: SandboxCleanupEvidence['postconditions'];
  failureClasses: SandboxCleanupFailureClass[];
  retryable: boolean;
  attempt: number;
  evidencePersisted: boolean;
}

export interface SandboxInventory {
  totalHomes: number;
  validHomes: number;
  malformedHomes: number;
  unsafeEntries: number;
}

export interface SandboxSweepResult {
  completed: string[];
  residual: string[];
  refused: string[];
  unavailable: string[];
  /** Raw on-disk state, including homes that could not be safely classified. */
  inventory: SandboxInventory;
  /** Valid sandbox ids whose cleanup unexpectedly threw. */
  unexpectedErrors: string[];
}

/**
 * M21: the captured result of work done inside a sandbox - the git diff of the
 * worktree vs. its base. This is what an autonomous run PROPOSES; proposal-only
 * is the default posture (nothing is applied to the source repo). METADATA +
 * patch text only.
 */
export interface SandboxDiff {
  /** Id of the sandbox this diff was captured from. */
  sandboxId: string;
  /** Number of files changed. */
  files: number;
  /** Total inserted lines across the diff. */
  insertions: number;
  /** Total deleted lines across the diff. */
  deletions: number;
  /** The unified diff patch text (git diff output). */
  patch: string;
}

/**
 * M21: one append-only audit record of an autonomous/sandbox action. Written to
 * ~/.ashlr/audit/<date>.jsonl - never deleted, never holds secrets. Read back
 * via `ashlr audit`.
 */
export interface AuditEntry {
  /** ISO timestamp the action occurred (set by `audit()`, not the caller). */
  ts: string;
  /** Short action verb, e.g. 'sandbox.create', 'enroll.add', 'kill.set'. */
  action: string;
  /** Absolute source repo path the action concerned, or null if not repo-scoped. */
  repo: string | null;
  /** Sandbox id the action concerned, or null if not sandbox-scoped. */
  sandboxId: string | null;
  /** One-line human-readable summary - metadata only, never secrets. */
  summary: string;
  /** Outcome of the action. */
  result: 'ok' | 'refused' | 'error';
}

/**
 * M21: the enrollment registry - which repos are ENROLLED for autonomous work.
 * DEFAULT EMPTY: nothing enrolled => nothing autonomous can mutate any real
 * repo. Persisted in cfg.autonomy / ~/.ashlr/enrollment.json.
 */
export interface Enrollment {
  /** Absolute paths of repos enrolled for autonomous/sandbox mutation. */
  repos: string[];
}
