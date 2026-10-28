/** Shared skills contracts. Public entry point: ../types.ts. */
import type { EvidenceOutcomeSummary, LabelBasis, LearningSource, RouteSnapshot, RunEventSummary } from './learning.js';

export type SkillCardStatus = 'candidate' | 'verified' | 'deprecated' | 'revoked';
export type SkillCardSource = 'verified-proposal' | 'manual' | 'imported';
export type SkillUseMode = 'shadow' | 'active' | 'disabled';
export type SkillUseStage = 'selected' | 'injected' | 'applied' | 'outcome';
export type SkillUseOutcome =
  | 'unknown'
  | 'verified'
  | 'merged'
  | 'rejected'
  | 'reverted'
  | 'followed-up'
  | 'failed'
  | 'skipped';

/** Fixed-key verification metadata for a skill card revision. */
export interface SkillCardVerification {
  passed: boolean;
  verifiedAt?: string;
  commandKinds?: string[];
  diffHash?: string;
  riskClass?: string;
  evidenceCount?: number;
}

/**
 * A bounded, metadata-only skill revision. Raw prompts, diffs, process output,
 * environment values, file contents, argv, and command output are forbidden.
 */
export interface SkillCard {
  schemaVersion: 1;
  skillId: string;
  revision: number;
  ts: string;
  name: string;
  summary: string;
  status: SkillCardStatus;
  source: SkillCardSource;
  tags?: string[];
  taskKinds?: string[];
  commandKinds?: string[];
  verification?: SkillCardVerification;
  /** SHA-256 of the canonical immutable card payload (excluding attestation fields). */
  contentHash?: string;
  /** Domain-separated host-local HMAC binding this card revision to its proposal evidence. */
  attestation?: string;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
}

/** Append-only metadata describing selection and outcomes for one skill use. */
export interface SkillUseEvent {
  schemaVersion: 1;
  eventId: string;
  ts: string;
  skillId: string;
  skillRevision: number;
  /** Signed card content hash observed at selection time. */
  contentHash?: string;
  /** Stable time at which the signed corpus snapshot was selected. */
  selectedAt?: string;
  /** Selection policy version, independent of the fleet router policy. */
  skillPolicyVersion?: string;
  mode: SkillUseMode;
  stage: SkillUseStage;
  outcome?: SkillUseOutcome;
  rank?: number;
  score?: number;
  reason?: string;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
}
