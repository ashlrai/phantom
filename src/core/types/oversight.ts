/** Shared oversight contracts. Public entry point: ../types.ts. */
import type { WorkSource } from './backlog.js';
import type { AgentSemanticEventV1, EvidenceOutcomeSummary, LabelBasis, LearningSource, RouteSnapshot, RunEventSummary } from './learning.js';

// ---------------------------------------------------------------------------
// M119: Fleet oversight - decisions ledger + quality metrics
// ---------------------------------------------------------------------------

/**
 * M119: One entry in the append-only decisions ledger
 * (~/.ashlr/decisions/YYYY-MM-DD.jsonl).
 */
export type JudgeDecisionReasonCode =
  | 'judge-ship-would-merge'
  | 'judge-ship-review-required'
  | 'judge-review'
  | 'judge-noise'
  | 'judge-harmful'
  | 'judge-verdict-unrecognized'
  /** Judge responded but its output could not be parsed as a verdict (after retry). NOT a considered judgment. */
  | 'judge-parse-failure'
  /** The judge call itself failed (network/API/spawn error) - no model response was obtained. NOT a considered judgment. */
  | 'judge-network-failure';

export interface DecisionEntry {
  /** ISO timestamp. */
  ts: string;
  /** The proposal this event belongs to. */
  proposalId: string;
  /** Optional originating backlog/work item id for item-accurate learning. */
  workItemId?: string;
  /** Optional originating backlog scanner/source. */
  workSource?: WorkSource;
  /** Optional run/swarm id that produced the proposal. */
  runId?: string;
  /** Stable attempt/work trajectory id used to join proposal, dispatch, and decisions. */
  trajectoryId?: string;
  /** Metadata-only route snapshot for producer/dispatch decisions. */
  routeSnapshot?: RouteSnapshot;
  /** Metadata-only run summary; never includes prompts, diffs, stdout, or stderr. */
  runEventSummary?: RunEventSummary;
  /** Metadata-only evidence/policy outcome summary for learning joins. */
  evidenceOutcome?: EvidenceOutcomeSummary;
  /** Where this row should be treated as learning input from. */
  learningSource?: LearningSource;
  /** Which signal made this row a label for learning. */
  labelBasis?: LabelBasis;
  /** Version of the router policy/snapshot format that produced this row. */
  routerPolicyVersion?: string;
  /** Coarse learning epoch, currently an ISO day string. */
  learningEpoch?: string;
  /** Bounded metadata-only semantic events. Observational; never merge authority. */
  semanticEvents?: AgentSemanticEventV1[];
  /** Writer rejected a supplied semantic batch; parent history remains readable. */
  semanticEventsState?: 'rejected';
  /** Lifecycle action. */
  action:
    | 'proposed'
    | 'verified'
    | 'judged'
    /** Manager gate passed; no mutation or host merge has been observed. */
    | 'merge-authorized'
    | 'merged'
    | 'handoff'
    | 'rejected'
    | 'escalated'
    | 'self-improve:written'
    | 'skill-library:written';
  /** Engine id (e.g. 'codex', 'claude'). */
  engine?: string;
  /** Engine model string (e.g. 'codex:gpt-5.5'). */
  model?: string;
  /** Human-readable verdict (e.g. 'approved', 'rejected'). */
  verdict?: string;
  /** Metadata-only schema marker for judged decisions. */
  judgeDecisionMetadataVersion?: 1 | 2;
  /** Deterministic code derived from verdict and authenticated merge intent. */
  judgeReasonCode?: JudgeDecisionReasonCode;
  /** Explains why model-authored rationale is absent from the read model. */
  judgeRationaleState?: 'not-persisted' | 'legacy-redacted';
  /** Human-readable reason for the decision. */
  reason?: string;
  /** Optional extra detail (secret-scrubbed before persisting). */
  detail?: string;
  /**
   * M157: HMAC-signed judge attestation for frontier 'ship' verdicts.
   * Produced by signJudgeAttestation in provenance.ts; verified by
   * evaluateVerificationGate criterion 1 to prevent forged ledger entries.
   * Only present when action==='judged' AND verdict==='ship' AND the judge is
   * a frontier (claude-*) model.
   */
  judgeAttestation?: string;
  /** Authenticated issuance time for replay-resistant cached judge authority. */
  judgeAttestationIssuedAt?: string;
  /** Authenticated merge intent; currently only `would-merge` can grant authority. */
  judgeAttestationIntent?: 'would-merge';
  /**
   * M246: Telemetry truth - optional measurement fields added at the emit site.
   * All absent on pre-M246 ledger entries; callers must treat as optional.
   */
  /** Estimated USD cost of the engine call that produced this decision. */
  costUsd?: number;
  /** Input tokens consumed. */
  tokensIn?: number;
  /** Output tokens produced. */
  tokensOut?: number;
  /** Wall-clock duration of the engine spawn in milliseconds. */
  durationMs?: number;
  /** Whether the response was served from the provider's prompt cache. */
  cacheHit?: boolean;
}

/** M119: Per-engine quality breakdown. */
export interface EngineQuality {
  created: number;
  merged: number;
  rejected: number;
  /** merged / created */
  acceptRate: number;
  /** Average changed lines across proposals with a diff. */
  avgDiffLines: number;
  /** Share of proposals that are trivial (≤6 diff lines or trivial title). */
  trivialRatio: number;
}

/** M119: Aggregate quality metrics over a time window. */
export interface QualityMetrics {
  /** The window this snapshot covers ('7d' | '30d' | 'all'). */
  window: string;
  /** Total proposals created in the window. */
  proposalsCreated: number;
  /** Proposals with receipt-qualified realized merge evidence. */
  merged: number;
  /** Proposals rejected (rejected + failed). */
  rejected: number;
  /** Proposals still pending (live count, not window-filtered). */
  pending: number;
  /** Proposals that carried a non-empty diff. */
  withDiff: number;
  /** Share of proposals without a diff (empty-patch rate). */
  emptyRate: number;
  /** Share of proposals that are trivially small (≤6 diff lines or doc-only title). */
  trivialRatio: number;
  /** receipt-qualified realized merges / created */
  acceptRate: number;
  /** (rejected + failed) / created */
  rejectRate: number;
  /** verifyResult.passed / proposals with verifyResult present */
  verifyPassRate: number;
  /** Average diff lines across proposals that have a diff. */
  avgDiffLines: number;
  /** Per-engine breakdown keyed by engineModel (or '(unknown)'). */
  byEngine: Record<string, EngineQuality>;
  /** Per-repo proposal count in the window keyed by repo path. */
  byRepo: Record<string, number>;
  /** Optional multi-period trend (weekly buckets from decisions ledger). */
  trend?: { period: string; acceptRate: number; merged: number }[];
}
