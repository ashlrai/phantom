/** Public ledger contracts. */

import type {
  WorkItem,
  EngineId,
  EngineTier,
  DaemonDispatchProductionOutcome,
  RouteSnapshot,
  RunEventSummary,
  EvidenceOutcomeSummary,
  LearningSource,
  LabelBasis,
  RepairTreatment,
  RunActionCounts,
  ProductionAttemptShape,
} from '../../types.js';
import type { ProductionAttemptLearningLabel } from '../../learning/attempt-shape.js';
import { DISPATCH_PRODUCTION_INVALID_REASON_CODES } from './constants.js';

export type DispatchProductionBasis =
  | 'run-proposal-outcome'
  | 'pending-proposal-delta'
  | 'best-of-n-summary'
  | 'repair-lifecycle-candidate'
  | 'repair-lifecycle-outcome'
  | 'unknown';

export type DispatchProductionLabelOrigin =
  | 'stored-current'
  | 'stored-legacy'
  | 'derived-on-read';

export interface DispatchProductionEvent {
  /** V2 withholds provenance-bearing rows from legacy readers without migrating V1. */
  schemaVersion: 1 | 2;
  ts: string;
  machineId?: string;
  itemId: string;
  source: WorkItem['source'];
  repo: string;
  title: string;
  backend: EngineId | null;
  tier: EngineTier | null;
  model?: string | null;
  assignedBy: string;
  routeReason: string;
  outcome: DaemonDispatchProductionOutcome;
  proposalCreated: boolean;
  proposalId?: string;
  /** Writer-issued immutable identity allocated before this dispatch begins. */
  attemptId?: string;
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  /** Scrubbed metadata-only hash of the dispatched work item's objective. */
  objectiveHash?: string;
  learningLabel?: ProductionAttemptLearningLabel;
  /** Read-time provenance only; never persisted as part of the immutable event. */
  labelOrigin?: DispatchProductionLabelOrigin;
  spentUsd: number;
  diffFiles?: number;
  diffLines?: number;
  reason?: string;
  basis: DispatchProductionBasis;
  /** Metadata-only exact lineage for journal-authorized diagnostic repair dispatches. */
  repairHandoffId?: string;
  repairGenerationId?: string;
  repairTreatmentUnitId?: string;
  repairTreatment?: RepairTreatment;
  /** Terminal outcome emitted only after the local lifecycle store commits it. */
  repairTreatmentOutcome?: 'converted' | 'not-converted';
  repairTreatmentAttemptHash?: string;
  repairAttemptOrdinal?: 1 | 2;
  repairPreviousBackend?: EngineId;
  /** Exact generated-repair reservation root identity for immutable failure receipts. */
  repairRootId?: string;
  repairDepth?: 0 | 1;
  repairLineageInvalid?: true;
}

export interface CanonicalDispatchProductionAttempts {
  events: DispatchProductionEvent[];
  /** Historical rows that predate the complete attempt envelope; observation only. */
  preEnvelopeEvents: number;
  duplicateEvents: number;
  invalidAttemptIdentities: number;
  conflictingAttemptIdentities: number;
}

export interface ReadDispatchProductionEventsOptions {
  /** Recorded feedback requires exact writer ISO timestamps, before window filtering. */
  canonicalTimestamps?: boolean;
  sinceMs?: number;
  limit?: number;
  /** Maximum dated partitions. Loose legacy partitions retain their separate fixed cap. */
  maxFiles?: number;
  /** Aggregate bytes physically read across selected partitions. */
  maxBytes?: number;
  /** Aggregate physical rows examined, including blank and invalid rows. */
  maxRows?: number;
  /** Inspect without creating a receipt lock or changing storage metadata. */
  inspectionOnly?: boolean;
}

export interface DispatchProductionParentIdentity {
  ts: string;
  itemId: string;
  repo: string;
  outcome: string;
  attemptId: string;
  source?: WorkItem['source'];
  backend?: EngineId | null;
  tier?: EngineTier | null;
  objectiveHash?: string;
}

export type DispatchProductionParentStatus = 'found' | 'missing' | 'degraded';

export interface DispatchProductionAttemptProofTarget {
  ts: string;
  /** Inclusive bounded scan start for generation-wide conflict detection. */
  sequenceStartTs?: string;
  /** Inclusive bounded scan end; lifecycle uses a cutoff captured under the generation fence. */
  sequenceEndTs?: string;
  itemId: string;
  repo: string;
  source: WorkItem['source'];
  outcome: 'empty-diff' | 'proposal-created';
  /** Required exactly for proposal-created targets and forbidden for empty-diff targets. */
  proposalId?: string;
  objectiveHash: string;
  repairHandoffId: string;
  repairGenerationId: string;
  repairTreatmentUnitId: string;
  repairTreatment: RepairTreatment;
  repairAttemptOrdinal: 1 | 2;
}

export interface DispatchProductionAttemptProof {
  schemaVersion: 1;
  integrityClass: 'owner-writable-local';
  cryptographicallyTrusted: false;
  rollbackProtected: false;
  eventTs: string;
  eventDigest: string;
  attemptHash: string;
  backend: Exclude<EngineId, 'builtin'>;
  tier: EngineTier;
  model: string | null;
  previousBackend: Exclude<EngineId, 'builtin'> | null;
  repairHandoffId: string;
  repairGenerationId: string;
  repairTreatmentUnitId: string;
  repairTreatment: RepairTreatment;
  repairAttemptOrdinal: 1 | 2;
}

export interface DispatchProductionFailureAttemptProof extends
  Omit<DispatchProductionAttemptProof, 'repairTreatmentUnitId' | 'repairTreatment'> {
  repairTreatmentUnitId?: string;
  repairTreatment?: RepairTreatment;
}

export interface DispatchProductionFailureAttemptReceiptTarget {
  repairGenerationId: string;
  repairAttemptOrdinal: 1 | 2;
  attemptHash: string;
}

export type DispatchProductionFailureAttemptReceiptResolution =
  | { status: 'proven'; proof: DispatchProductionFailureAttemptProof; event: DispatchProductionEvent }
  | { status: 'missing'; reason: 'receipt-missing' | 'receipt-uncommitted' }
  | { status: 'unproven'; reason: 'target-mismatch' | 'event-ineligible' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionFailureAttemptReceiptBatchResolution =
  | { status: 'resolved'; authoritative: boolean; receipts: Array<{
      proof: DispatchProductionFailureAttemptProof;
      event: DispatchProductionEvent;
    }> }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionAttemptProofDegradedReason =
  | 'target-invalid'
  | 'target-limit'
  | 'date-limit'
  | 'source-unavailable'
  | 'source-unsafe'
  | 'source-mutated'
  | 'partition-unreadable'
  | 'partition-byte-limit'
  | 'partition-row-limit'
  | 'partition-invalid'
  | 'partition-conflict'
  | 'retirement-membership-saturated';

export interface DispatchProductionWriteResult {
  attempted: number;
  recorded: number;
  failed: number;
  failureReasons?: Array<'retirement-membership-saturated'>;
}

export interface DispatchProductionAttemptProtocolQuality {
  status: 'healthy' | 'saturated' | 'degraded';
  segmentCount: number;
  estimatedFalsePositiveRate: number;
  maxFalsePositiveRate: number;
}

export type DispatchProductionAttemptProofResolution =
  | { status: 'proven'; proof: DispatchProductionAttemptProof }
  | { status: 'missing'; reason: 'partition-missing' | 'event-missing' }
  | { status: 'unproven'; reason: 'event-ineligible' | 'target-mismatch' |
      'attempt-sequence-missing' | 'attempt-sequence-mismatch' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionAttemptProofBatchResolution =
  | { status: 'resolved'; resolutions: DispatchProductionAttemptProofResolution[] }
  | { status: 'degraded'; reason: 'target-limit' };

export type DispatchProductionAttemptWitnessResolution =
  | { status: 'proven'; proof: DispatchProductionAttemptProof; event: DispatchProductionEvent }
  | Exclude<DispatchProductionAttemptProofResolution, { status: 'proven' }>;

export type DispatchProductionAttemptWitnessBatchResolution =
  | { status: 'resolved'; resolutions: DispatchProductionAttemptWitnessResolution[] }
  | { status: 'degraded'; reason: 'target-limit' };

export interface DispatchProductionAttemptReceiptWitnessTarget {
  repairGenerationId: string;
  repairAttemptOrdinal: 1 | 2;
}

export type DispatchProductionAttemptReceiptWitnessResolution =
  | { status: 'proven'; proof: DispatchProductionAttemptProof; event: DispatchProductionEvent }
  | { status: 'missing'; reason: 'receipt-missing' | 'receipt-uncommitted' }
  | { status: 'unproven'; reason: 'event-ineligible' |
      'attempt-sequence-missing' | 'attempt-sequence-mismatch' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionAttemptReceiptWitnessBatchResolution =
  | { status: 'resolved'; resolutions: DispatchProductionAttemptReceiptWitnessResolution[] }
  | { status: 'degraded'; reason: 'target-limit' };

export type DispatchProductionAttemptReceiptAvailabilityResolution =
  | { status: 'available'; proof: DispatchProductionAttemptProof; event: DispatchProductionEvent }
  | { status: 'missing'; reason: 'raw-append-missing' }
  | { status: 'missing'; reason: 'receipt-missing-after-append';
      proof: DispatchProductionAttemptProof; event: DispatchProductionEvent }
  | { status: 'unproven'; reason: 'event-ineligible' | 'target-mismatch' |
      'attempt-sequence-missing' | 'attempt-sequence-mismatch' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionAttemptReceiptAvailabilityBatchResolution =
  | { status: 'resolved'; resolutions: DispatchProductionAttemptReceiptAvailabilityResolution[] }
  | { status: 'degraded'; reason: 'target-limit' };

export type DispatchProductionReadStopReason =
  | 'event-limit'
  | 'file-limit'
  | 'byte-limit'
  | 'row-limit'
  | 'io-error'
  | 'attempt-identity-unavailable'
  | 'attempt-identity-conflict';

export interface DispatchProductionSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: DispatchProductionReadStopReason[];
  filesRead: number;
  datedFilesRead: number;
  looseFilesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface DispatchProductionEventsReadResult extends DispatchProductionSourceQuality {
  events: DispatchProductionEvent[];
  /** Bounded aggregate diagnostics only; never includes row values or file paths. */
  invalidReasonCounts?: DispatchProductionInvalidReasonCount[];
}

export type DispatchProductionInvalidReasonCode =
  typeof DISPATCH_PRODUCTION_INVALID_REASON_CODES[number];

export interface DispatchProductionInvalidReasonCount {
  reason: DispatchProductionInvalidReasonCode;
  count: number;
}

export interface DispatchProductionYieldReadResult {
  summary?: DispatchProductionYieldSummary;
  sourceQuality: DispatchProductionSourceQuality;
  /** Exact bounded event snapshot used to derive both summary and source quality. */
  events: DispatchProductionEvent[];
}

export interface DispatchProductionReasonCount {
  reason: string;
  count: number;
}

export interface DispatchProductionOutcomeCounts {
  proposalCreated: number;
  emptyDiff: number;
  gateBlocked: number;
  engineFailed: number;
  /** Optional for compatibility with callers that construct legacy count fixtures. */
  cancelled?: number;
  sandboxFailed: number;
  proposalCaptureError: number;
  proposalDisabled: number;
  unknown: number;
}

export interface GeneratedRepairAttemptSummary {
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  captureRepairs: number;
  diagnosticReslices: number;
  proposalRepairs: number;
  /** Explicit event/unit attribution quality; never inferred from conversion output. */
  treatmentAttribution?: RepairTreatmentAttributionSummary;
  /** Per-treatment conversion is withheld until each arm has a bounded minimum sample. */
  treatmentConversions?: RepairTreatmentConversionSummary[];
}

export interface RepairTreatmentAttributionSummary {
  eligibleEvents: number;
  attributedEvents: number;
  unattributedEvents: number;
  distinctUnits: number;
  replayedEvents: number;
  minimumTerminalUnitsPerArm: 3;
  arms: RepairTreatmentAttributionArmSummary[];
  gate: 'collecting' | 'ready' | 'withheld';
  blockers: RepairTreatmentAttributionBlocker[];
}

export interface RepairTreatmentAttributionArmSummary {
  repairTreatment: RepairTreatment;
  attributedUnits: number;
  terminalUnits: number;
  remaining: number;
}

export type RepairTreatmentAttributionBlocker =
  | 'in-flight'
  | 'unmatched-terminal'
  | 'unattributed'
  | 'replayed'
  | 'source-incomplete';

export interface RepairTreatmentConversionSummary {
  repairTreatment: RepairTreatment;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
}

export interface GeneratedRepairBackendTransitionBucket {
  previousBackend: EngineId;
  retryBackend: EngineId;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate?: number;
  outcomes: DispatchProductionOutcomeCounts;
}

export interface GeneratedRepairBackendTransitionSummary {
  sourceState: 'healthy' | 'degraded';
  lineageEvents: number;
  transitionEvents: number;
  attempts: number;
  duplicateEvents: number;
  conflictingAttempts: number;
  invalidLineageEvents: number;
  byTransition: GeneratedRepairBackendTransitionBucket[];
}

export interface DispatchProductionYieldBucket {
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  repo?: string;
  model?: string | null;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate?: number;
  /** Optional for compatibility with summaries persisted before diagnostic accounting. */
  diagnosticAttempts?: number;
  diagnosticNoProposal?: number;
  diagnosticProposalRate?: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts?: RunActionCounts;
  attemptShape?: ProductionAttemptShape;
  generatedRepairAttempts?: GeneratedRepairAttemptSummary;
  topReasons: DispatchProductionReasonCount[];
  diagnosticTopReasons?: DispatchProductionReasonCount[];
}

export interface DispatchProductionYieldSummary {
  windowHours: number;
  attempts: number;
  events: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate?: number;
  preEnvelopeEvents?: number;
  duplicateEvents?: number;
  invalidAttemptIdentities?: number;
  conflictingAttemptIdentities?: number;
  cancelledEvents?: number;
  /** Optional for compatibility with summaries persisted before diagnostic accounting. */
  diagnosticAttempts?: number;
  diagnosticNoProposal?: number;
  diagnosticProposalRate?: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts?: RunActionCounts;
  attemptShape?: ProductionAttemptShape;
  generatedRepairAttempts?: GeneratedRepairAttemptSummary;
  generatedRepairBackendTransitions?: GeneratedRepairBackendTransitionSummary;
  topReasons: DispatchProductionReasonCount[];
  diagnosticTopReasons?: DispatchProductionReasonCount[];
  byBackend: DispatchProductionYieldBucket[];
  bySource: DispatchProductionYieldBucket[];
  byRepo: DispatchProductionYieldBucket[];
  byBackendModel: DispatchProductionYieldBucket[];
  byBackendSource: DispatchProductionYieldBucket[];
}
