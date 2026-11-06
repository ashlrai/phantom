/**
 * Append-only proposal-production outcome stream.
 *
 * Writes metadata-only rows to ~/.ashlr/dispatch-production/YYYY-MM-DD.jsonl
 * (or $ASHLR_HOME/dispatch-production). This is history/analytics, not the
 * cooldown ledger: never truncate, never rewrite, never throw.
 *
 * Compatibility barrel. Internal modules import their dependencies directly.
 */

export {
  DISPATCH_PRODUCTION_INVALID_REASON_CODES,
} from './dispatch-production-ledger/constants.js';

export {
  type DispatchProductionBasis,
  type DispatchProductionLabelOrigin,
  type DispatchProductionEvent,
  type CanonicalDispatchProductionAttempts,
  type ReadDispatchProductionEventsOptions,
  type DispatchProductionParentIdentity,
  type DispatchProductionParentStatus,
  type DispatchProductionAttemptProofTarget,
  type DispatchProductionAttemptProof,
  type DispatchProductionFailureAttemptProof,
  type DispatchProductionFailureAttemptReceiptTarget,
  type DispatchProductionFailureAttemptReceiptResolution,
  type DispatchProductionFailureAttemptReceiptBatchResolution,
  type DispatchProductionAttemptProofDegradedReason,
  type DispatchProductionWriteResult,
  type DispatchProductionAttemptProtocolQuality,
  type DispatchProductionAttemptProofResolution,
  type DispatchProductionAttemptProofBatchResolution,
  type DispatchProductionAttemptWitnessResolution,
  type DispatchProductionAttemptWitnessBatchResolution,
  type DispatchProductionAttemptReceiptWitnessTarget,
  type DispatchProductionAttemptReceiptWitnessResolution,
  type DispatchProductionAttemptReceiptWitnessBatchResolution,
  type DispatchProductionAttemptReceiptAvailabilityResolution,
  type DispatchProductionAttemptReceiptAvailabilityBatchResolution,
  type DispatchProductionReadStopReason,
  type DispatchProductionSourceQuality,
  type DispatchProductionEventsReadResult,
  type DispatchProductionInvalidReasonCode,
  type DispatchProductionInvalidReasonCount,
  type DispatchProductionYieldReadResult,
  type DispatchProductionReasonCount,
  type DispatchProductionOutcomeCounts,
  type GeneratedRepairAttemptSummary,
  type RepairTreatmentAttributionSummary,
  type RepairTreatmentAttributionArmSummary,
  type RepairTreatmentAttributionBlocker,
  type RepairTreatmentConversionSummary,
  type GeneratedRepairBackendTransitionBucket,
  type GeneratedRepairBackendTransitionSummary,
  type DispatchProductionYieldBucket,
  type DispatchProductionYieldSummary,
} from './dispatch-production-ledger/types.js';

export {
  dispatchProductionDir,
  withDispatchProductionGenerationAuthority,
  readDispatchProductionParents,
} from './dispatch-production-ledger/storage.js';

export {
  hasExactDispatchProductionTreatmentOutcomeReceipt,
} from './dispatch-production-ledger/treatment-receipts.js';

export {
  dispatchProductionRunStatusForOutcome,
  canonicalDispatchRepoIdentity,
  sanitizeDispatchProductionEvent,
  materializeDispatchProductionAttemptEnvelope,
} from './dispatch-production-ledger/events.js';

export { recordDispatchProduction } from './dispatch-production-ledger/write.js';

export {
  readDispatchProductionAttemptProtocolQuality,
} from './dispatch-production-ledger/attempt-retention.js';

export {
  _setDispatchProductionLedgerRetentionHooksForTest,
} from './dispatch-production-ledger/retention-hooks.js';

export {
  currentAuthoritativeDispatchProductionLearningLabel,
} from './dispatch-production-ledger/attempt-proofs.js';

export {
  resolveDispatchProductionFailureAttemptReceipt,
  readDispatchProductionFailureAttemptReceipts,
  resolveDispatchProductionAttemptProofs,
  resolveDispatchProductionAttemptWitnesses,
  resolveDispatchProductionAttemptReceiptWitnesses,
  readDispatchProductionAttemptReceiptAvailability,
} from './dispatch-production-ledger/attempt-resolution.js';

export {
  readDispatchProductionEventsDetailed,
  readDispatchProductionEvents,
} from './dispatch-production-ledger/read.js';

export {
  isCancelledDispatchProductionEvent,
  canonicalDispatchProductionAttempts,
  summarizeDispatchProductionYield,
  readDispatchProductionYieldDetailed,
  readDispatchProductionYield,
} from './dispatch-production-ledger/yield.js';
