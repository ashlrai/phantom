/** Shared proposals contracts. Public entry point: ../types.ts. */
import type { RepairDepth, WorkSource } from './backlog.js';
import type { DelegationScopeSummary } from './delegation.js';
import type { EngineTier } from './engines.js';
import type { EvidenceOutcomeSummary, LabelBasis, LearningSource, RouteSnapshot, RunEventSummary } from './learning.js';

export interface VisualGroundingEvidence {
  status: 'ok' | 'blocked' | 'skipped' | 'no-boxes' | 'failed';
  provider: 'locateanything-http' | 'generic-openai-vision' | 'disabled';
  boxCount: number;
  boxes: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    scale: 'normalized-1000';
    label?: string;
    confidence?: number;
  }>;
  image?: {
    bytes: number;
    sha256: string;
  };
  detail: string;
}

export interface ProposalBrowserVerifyEvidence {
  ok: boolean;
  renderOk: boolean;
  consoleErrorCount: number;
  screenshotCaptured: boolean;
  detail: string;
  visualGrounding?: VisualGroundingEvidence;
}

export type AutoMergeTrustBasis = 'tier' | 'verification' | 'evidence';

/**
 * A protected-remote check expectation. String entries are retained only for
 * config compatibility and are not sufficient authority in evidence mode.
 */
export type ProtectedRemoteRequiredCheckExpectation = string | {
  context: string;
  /** GitHub App/integration id required for this check context. */
  appId: string | number;
};

/** Observed policy metadata only; never permission to exercise bypass. */
export interface ProtectedPrObservedBypass {
  rulesetId: string;
  sourceType: 'Repository' | 'Organization' | 'Enterprise';
  source: string;
  actorType: 'RepositoryRole';
  actorId: string;
  bypassMode: 'always' | 'pull_request';
}

/** Exact repository-bound expectation for opening a PR, never landing it. */
export interface ProtectedRemoteRepositoryExpectation {
  nameWithOwner: string;
  /** Existing authenticated GitHub node ID; not a REST database ID. */
  repositoryId: string;
  defaultBranch: string;
  operation: 'protected-pr-handoff-v1';
  branchProtection: boolean;
  requiredChecks: Array<Exclude<ProtectedRemoteRequiredCheckExpectation, string>>;
  observedRulesetBypassActors: ProtectedPrObservedBypass[];
}

/**
 * M23: what kind of outward action a Proposal represents.
 *   'patch'          - a unified diff to be applied on a NEW branch in the target repo.
 *   'pr'             - a branch+commit then a gated `gh pr create` (the M18 createPr).
 *   'deploy'         - the gated ship/deploy path.
 *   'note'           - a no-op record (decision/observation only; never mutates).
 *   'desktop-action' - open a path in the user's editor/finder/terminal (Phase 2).
 *   'browser-action' - future Claude-in-Chrome gateway action (Phase 2b, not yet active).
 */
export type ProposalKind = 'patch' | 'pr' | 'deploy' | 'note' | 'desktop-action' | 'browser-action';

/**
 * M23: lifecycle of a Proposal through the approval inbox gate.
 *   'pending'  - created, awaiting Mason's explicit decision (NEVER auto-applies).
 *   'approved' - Mason approved; eligible for applyProposal (still confirm-gated).
 *   'rejected' - Mason rejected; discarded, never applied.
 *   'awaiting-host-merge'
 *              - Ashlr handed off a remote PR to the host, but has NOT proven the
 *                host merged it yet.
 *   'applied'  - the approved outward action was performed successfully.
 *   'failed'   - apply was attempted (approved+confirmed) but errored.
 */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'awaiting-host-merge' | 'applied' | 'failed';

export interface ProposalVerifyResult {
  passed: boolean;
  failed?: string[];
  detail?: string;
  /**
   * Present only when passed:false. Distinguishes WHY verification failed:
   * Only explicit 'code' means the verifier ran and found a real problem with
   * the diff. An absent category is legacy/unknown and cannot authorize
   * permanent rejection. 'tool' means the verifier itself
   * could not be executed (missing binary, exit 127, spawn ENOENT - a
   * verifier-unavailable outcome, not a judgment on the diff). 'timeout' and
   * 'infra' are likewise infrastructure signals, not code signals. Consumers
   * that gate permanent rejection/auto-archival on verification failure MUST
   * check this before treating a failure as fatal to the proposal.
   */
  failureCategory?: 'code' | 'tool' | 'timeout' | 'infra' | 'cancelled' | 'invalid-command';
  ran?: Array<{
    id?: string;
    kind: 'typecheck' | 'lint' | 'build' | 'test';
    cmd: string[];
    cwd?: string;
    timeoutMs?: number;
    required?: boolean;
    profiles?: Array<'quick' | 'merge' | 'deep'>;
  }>;
  browser?: ProposalBrowserVerifyEvidence;
  baseBranch?: string;
  baseHead?: string;
  /** Hash of the proposal diff that was verified. Required for judge-free evidence reuse. */
  diffHash?: string;
  /**
   * 3.14: digest of the `file:../<sibling>` mirror pins the verification ran
   * against (fleet/mirrors.ts siblingPinsDigest); absent when the repo has
   * none. A sibling that moves makes the binding stale.
   */
  siblingPins?: string;
  verifiedAt?: string;
  source?: 'auto-merge' | 'auto-merge-preflight' | 'manual' | string;
}

export interface RemoteHandoffReconciliation {
  schemaVersion: 1;
  /** Local observation time, bound with the exact host merge tuple. */
  observedAt: string;
  /** HMAC produced only after a successful remote-host reconciliation read. */
  attestation: string;
}

export interface ProposalRemoteAuthorityBinding {
  provider: 'github';
  /** Exact canonical GitHub repository identity authorized for host reads and PR creation. */
  nameWithOwner: string;
  /** Stable digest of the effective origin push destinations, with credentials removed. */
  pushAuthorityDigest: string;
}

export interface ProposalRemoteHandoffRecovery {
  schemaVersion: 1;
  attempt: 1;
  marker: '[ashlr-remote-handoff-retry:1]';
  authorizedAt: string;
}

export interface ProposalRemoteHandoff {
  provider: 'github';
  state: 'awaiting-host-merge' | 'merged' | 'closed' | 'unknown';
  prUrl?: string;
  branch?: string;
  base?: string;
  /** Exact verified staging commit expected at the PR head throughout reconciliation. */
  expectedHeadOid?: string;
  /** Host and push authority authenticated by the linked pre-effect/recovery intent. */
  authority?: ProposalRemoteAuthorityBinding;
  /** Exact local intent attestation this handoff record is allowed to reconcile from. */
  intentAttestation?: string;
  /** Present only after one proven no-PR recovery; a second recovery is forbidden. */
  recovery?: ProposalRemoteHandoffRecovery;
  /** Host-reported merge commit identity; persistence must require exactly 40 hex characters. */
  mergeCommitOid?: string;
  /** Authoritative host-reported merge time; never synthesized from local reconciliation time. */
  mergedAt?: string;
  reconciliation?: RemoteHandoffReconciliation;
  createdAt: string;
  updatedAt?: string;
  detail?: string;
}

/** Signed authorization minted after every merge gate passes and before local mutation. */
export interface ProposalLocalMergeIntent {
  schemaVersion: 1;
  /** New active authority binds evidencePackDigest to a verified signed evidence-pack v3 seal. */
  evidenceProtocol?: 'sealed-v3';
  branch: string;
  base: string;
  baseBeforeOid: string;
  proposalHeadOid: string;
  diffHash: string;
  evidencePackDigest: string;
  authorizationId: string;
  authorizedAt: string;
  /** Remote-only authority fields bound through authorizationId and this intent's HMAC. */
  remoteAuthority?: ProposalRemoteAuthorityBinding;
  attestation: string;
}

/** Exact unsigned observation returned by the local Git mutation boundary. */
export interface LocalDefaultBranchMergeObservation {
  schemaVersion: 1;
  source: 'local-default-branch';
  base: string;
  baseBeforeOid: string;
  proposalHeadOid: string;
  mergeCommitOid: string;
  observedAt: string;
}

/** Proposal-bound authenticated proof that a local merge was realized. */
export interface LocalDefaultBranchRealizedMerge extends LocalDefaultBranchMergeObservation {
  proposalId?: string;
  diffHash?: string;
  intentAttestation?: string;
  attestation?: string;
}

/** Exact, attested GitHub observation proving the host merged a proposal. */
export interface GithubHostRealizedMerge {
  schemaVersion: 1;
  source: 'github-host';
  provider: 'github';
  prUrl: string;
  branch: string;
  base: string;
  expectedHeadOid: string;
  mergeCommitOid: string;
  mergedAt: string;
  reconciliation: RemoteHandoffReconciliation;
}

/** Bounded persisted proof that an `applied` proposal is a realized merge. */
export type RealizedMergeEvidence =
  | LocalDefaultBranchRealizedMerge
  | GithubHostRealizedMerge;

/** Typed, bounded review projection of an existing inbox proposal. */
export interface ApprovalRequest {
  schemaVersion: 1;
  proposalId: string;
  /** Opaque revision of the complete review, including the full diff. */
  revision: string;
  action: { kind: ProposalKind; description: string; details?: string };
  scope: { repo: string | null; sandboxId?: string };
  diffPreview: { text: string; truncated: boolean };
}

export interface ApprovalDecision {
  revision: string;
  decision: 'approve' | 'deny';
  decidedAt: string;
}

/**
 * M23: a single PROPOSED outward action awaiting Mason's approval. The inbox is
 * the SINGLE human control plane through which EVERY outward mutation (PR, merge,
 * deploy, patch-applied-to-a-real-branch) must pass. The autonomous org (M24+)
 * creates these; nothing outward happens until Mason explicitly approves.
 * Persisted at ~/.ashlr/inbox/<id>.json. METADATA + diff/patch text only -
 * NEVER carries secret values.
 */
export interface Proposal {
  /** Stable unique id; also the inbox filename stem (~/.ashlr/inbox/<id>.json). */
  id: string;
  /** Durable card receipt; approval records consent, never execution evidence. */
  approvalDecision?: ApprovalDecision;
  /**
   * M109: The user identity that created this proposal (cfg.user?.id ?? cfg.user?.name).
   * Undefined when cfg.user is absent → no behavior change; backward-compatible.
   * Carried in OTLP spans as `ashlr.fleet.owner` for pulse team attribution.
   */
  owner?: string;
  /** Absolute path of the target repo, or null when not repo-scoped (e.g. note). */
  repo: string | null;
  /**
   * Where the proposal came from: the backlog, an autonomous swarm, manual
   * creation, or an agent session via the native MCP tool `ashlr_inbox_propose`
   * (M31). Agent-originated proposals are created 'pending' like every other -
   * the origin tag exists so the inbox can display provenance.
   */
  origin: 'backlog' | 'swarm' | 'manual' | 'agent';
  /** What kind of outward action this represents. */
  kind: ProposalKind;
  /** Short human-readable title for inbox lists. */
  title: string;
  /** Longer human-readable summary of what + why. */
  summary: string;
  /** Optional unified diff (from a sandbox) - the patch a 'patch'/'pr' applies. */
  diff?: string;
  /** Optional id of the sandbox the diff was captured from (M21). */
  sandboxId?: string;
  /** Optional originating backlog/work item id. Enables exact dedup and learning. */
  workItemId?: string;
  /** Hash binding a generated repair proposal to one immutable source generation. */
  workItemGenerationId?: string;
  /** Root metadata copied by producers that can preserve exact generated-repair ancestry. */
  repairRootId?: string;
  repairDepth?: RepairDepth;
  /** Optional originating backlog scanner/source. */
  workSource?: WorkSource;
  /** Optional run/swarm id that produced this proposal. */
  runId?: string;
  /** Stable attempt/work trajectory id used to join proposal, dispatch, and decisions. */
  trajectoryId?: string;
  /** Metadata-only route snapshot for the producer path; never includes prompts or diffs. */
  routeSnapshot?: RouteSnapshot;
  /** Metadata-only run summary; never includes prompts, diffs, stdout, or stderr. */
  runEventSummary?: RunEventSummary;
  /** Exact terminal producer state bound into current pending-proposal authority. */
  producerStatus?: 'running' | 'done' | 'failed' | 'aborted';
  /** Metadata-only evidence/policy outcome summary for learning joins. */
  evidenceOutcome?: EvidenceOutcomeSummary;
  /** Bounded delegation constraints/expectations; never includes raw prompt/output text. */
  delegationScope?: DelegationScopeSummary;
  /** Where this row should be treated as learning input from. */
  learningSource?: LearningSource;
  /** Which signal made this row a label for learning. */
  labelBasis?: LabelBasis;
  /** Version of the router policy/snapshot format that produced this row. */
  routerPolicyVersion?: string;
  /** Coarse learning epoch, currently an ISO day string. */
  learningEpoch?: string;
  /**
   * M45: provenance - backend + model that produced this proposal's diff
   * (e.g. 'codex:gpt-5.5'). A later merge-authority gate requires
   * engineTier === 'frontier' before any auto-apply to main.
   */
  engineModel?: string;
  engineTier?: EngineTier;
  /** M47.1: sha256 of the (scrubbed) diff at signing time. */
  diffHash?: string;
  /**
   * M47.1: HMAC over `${engineModel}|${engineTier}|${diffHash}` with the
   * per-machine provenance key - proves the trust tags were set by the
   * sandboxed producer (not forged on disk) and are bound to THIS diff.
   */
  provenanceSig?: string;
  /**
   * Producer attestation version used for causal learning. Version 2 binds the
   * proposal identity, canonical repo, work item/source, producer, and diff.
   * Legacy provenance may authorize lifecycle handling but earns no positive
   * routing or ROI credit.
   */
  producerProvenanceVersion?: 2;
  /** HMAC for the versioned producer attestation described above. */
  producerProvenanceSig?: string;
  /** Current signed envelope required for autonomous pending-proposal authority. */
  pendingAuthorityVersion?: 1;
  /** HMAC covering the complete immutable pending-proposal authority envelope. */
  pendingAuthoritySig?: string;
  /** Current lifecycle status. Created as 'pending'; NEVER auto-advances. */
  status: ProposalStatus;
  /** ISO timestamp the proposal was created. */
  createdAt: string;
  /** ISO timestamp Mason approved/rejected (set on the decision). */
  decidedAt?: string;
  /** Outcome detail recorded by applyProposal (branch name, PR url, error). */
  result?: string;
  /**
   * Metadata for remote host handoffs. A proposal with status
   * 'awaiting-host-merge' is not counted as landed until reconciliation proves
   * the host merged the PR.
   */
  remoteHandoff?: ProposalRemoteHandoff;
  /** Signed, one-generation local merge authorization; never itself proves a merge. */
  localMergeIntent?: ProposalLocalMergeIntent;
  /** Present only when an exact local or attested host merge was observed. */
  realizedMerge?: RealizedMergeEvidence;
  /**
   * Version 1 is a legacy best-effort fanout marker. Version 2 proves the
   * authoritative decision ledger contains exactly one realized-merge row.
   * Version 3 proves factual idempotent projections were durable. It does not
   * grant positive learning credit; that requires post-merge-credit-release-v1.
   */
  realizedMergeFanoutVersion?: 1 | 2 | 3;
  /**
   * M119/M307: Result of the verification step run against this proposal's diff.
   * Optional - not all proposals are verified before decision.
   */
  verifyResult?: ProposalVerifyResult;
  /**
   * M119: Human or manager-agent reason recorded at decide time.
   */
  decisionReason?: string;
  /**
   * M119: Risk classification for the change (set by manager or trust gate).
   */
  riskClass?: 'low' | 'medium' | 'high';
  /**
   * M183: Frontier TASTE critic scores (optional - only present when
   * cfg.foundry.tasteCritic is enabled and best-of-N selection ran).
   * Carries the three taste axes + overall + verdict from scoreTaste().
   * Used by the digest + Telegram curation to surface 'gold' proposals and
   * deprioritize 'mediocre' ones. Does NOT affect the safety merge gate.
   */
  taste?: {
    alignment: number;
    ambition: number;
    design: number;
    overall: number;
    verdict: 'gold' | 'solid' | 'mediocre';
    rationale: string;
  };
  /**
   * M259: count of consecutive non-ship judge verdicts (review/noise/harmful)
   * for this proposal. Incremented by runAutoMergePass each time the judge
   * returns a non-ship verdict. When this reaches cfg.foundry.autoArchiveAfterRejects
   * (default 3) the proposal is auto-rejected with reason 'auto-archived'.
   * Reset to 0 on a ship verdict (which proceeds to the merge gate as normal).
   * Optional - absent means 0; never present on proposals created before M259.
   */
  judgeNonShipCount?: number;
  /**
   * M271: passes in which this proposal was seen as non-ship-and-still-pending
   * (cheap drain counter - incremented WITHOUT a fresh judge call when the
   * proposal is capped out of judging this pass and already has judgeNonShipCount>=1).
   * When stuckPassCount reaches cfg.foundry.autoArchiveAfterRejects the proposal
   * is archived (status→rejected). Never present on proposals created before M271.
   */
  stuckPassCount?: number;
  /**
   * M233: set to true when the diff was captured after a timeout or non-zero
   * exit - the agent did real work before the cap but the run didn't finish
   * cleanly. The judge/merge gate still applies in full; this flag lets the
   * reviewer know the diff is potentially incomplete.
   */
  isPartial?: boolean;
  /**
   * M103: payload for 'desktop-action' proposals. Carries the specific UI
   * action to perform when the proposal is approved+applied.
   *
   * Vocabulary is intentionally narrow - safe, reversible, no arbitrary exec:
   *   'open-editor'   - open `target` in the configured editor.
   *   'open-finder'   - reveal `target` in Finder / Explorer.
   *   'open-terminal' - open a terminal at `target`.
   *
   * M105: 'browser-task' - navigate to `url` and execute `instructions` via
   *   the Claude-in-Chrome MCP server reachable through the gateway. Requires a
   *   configured + reachable browser MCP server; refuses cleanly (ok:false,
   *   no crash) when none is available (headless / daemon contexts).
   *
   * `target` must be an absolute path within an enrolled repo for desktop-action
   * kinds (enforced at apply time). `params` is reserved for future sub-options.
   * NEVER present on other proposal kinds.
   */
  action?: {
    type: 'open-editor' | 'open-finder' | 'open-terminal';
    target: string;
    params?: Record<string, unknown>;
  } | {
    type: 'browser-task';
    /** Optional URL to navigate to before running instructions. */
    url?: string;
    /** Natural-language instructions describing what to do in the browser. */
    instructions: string;
    params?: Record<string, unknown>;
  };
}

/**
 * M23: outcome of applyProposal - the ONLY outward path. Never thrown; failure
 * is reported here with status 'failed' and a detail. METADATA ONLY - no secrets.
 */
export interface ApplyResult {
  /** True only when the outward action completed successfully. */
  ok: boolean;
  /** The resulting proposal status: 'applied' on success, 'failed' otherwise. */
  status: ProposalStatus;
  /** Human-readable detail (branch created, PR url, refusal reason, error). */
  detail: string;
}
