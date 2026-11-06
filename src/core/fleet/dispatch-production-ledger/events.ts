/** Event sanitization, causal metadata, and attempt envelopes. */

import { scrubSecrets } from '../../util/scrub.js';
import { createHash } from 'node:crypto';
import type {
  RouteSnapshot,
  RunEventSummary,
  EvidenceOutcomeSummary,
  DaemonDispatchProductionOutcome,
  WorkItem,
  EngineId,
  EngineTier,
  RunActionCounts,
} from '../../types.js';
import {
  routeSnapshot as normalizeRouteSnapshot,
  runEventSummary as normalizeRunEventSummary,
  causalMetadata,
} from '../../learning/causal.js';
import { isSafeExecutionIdentity, isOuterAttemptIdentity } from '../attempt-identity.js';
import type { DispatchProductionEvent, DispatchProductionBasis } from './types.js';
import { isAbsolute } from 'node:path';
import { canonicalFilesystemPathIdentity } from '../../sandbox/policy.js';
import {
  ENGINE_IDS,
  ENGINE_TIERS,
  DISPATCH_PRODUCTION_OUTCOMES,
  DISPATCH_PRODUCTION_BASES,
  SHA256_RE,
  ATTEMPT_RECEIPT_FAILURE_OUTCOMES,
} from './constants.js';
import {
  repairTreatmentForUnitId,
  repairGenerationIdFromHandoffId,
  generatedRepairLifecycleAttemptHash,
} from '../generated-repair-identity.js';
import {
  sanitizeProductionAttemptLearningLabel,
  productionAttemptLearningLabelFromSignals,
} from '../../learning/attempt-shape.js';
import { tokenEnvelopeCurrent } from '../../run/token-evidence.js';
import { RUN_ACTION_COUNT_KEYS, isPreEnvelopeDispatchProductionEvent } from './yield.js';
import { isDeepStrictEqual } from 'node:util';
import { isPlainRecord } from './attempt-proofs.js';

export function eventDateString(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString().slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

function eventTimestamp(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function stripSecrets(value: string): string {
  return scrubSecrets(value);
}

function boundedText(value: string, max: number): string {
  const stripped = stripSecrets(value);
  return stripped.length > max ? `${stripped.slice(0, max - 3)}...` : stripped;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return boundedText(value, max);
}

function boundedNullableText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return boundedOptionalText(value, max);
}

const METADATA_DIGEST_RE = /^d1_[a-f0-9]{64}$/;

function metadataDigest(domain: string, value: unknown, fallback = 'unknown'): string {
  const text = typeof value === 'string' && value.trim() !== '' ? value : fallback;
  if (METADATA_DIGEST_RE.test(text)) return text;
  return `d1_${createHash('sha256').update(`ashlr:dispatch:${domain}:v1\0`).update(text).digest('hex')}`;
}

function optionalMetadataDigest(domain: string, value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? metadataDigest(domain, value) : undefined;
}

function dispatchRouteSnapshotMetadata(input: RouteSnapshot | undefined): RouteSnapshot | undefined {
  const normalized = normalizeRouteSnapshot(input);
  if (!normalized) return undefined;
  return {
    ...normalized,
    ...(normalized.assignedBy ? { assignedBy: metadataDigest('assigned-by', normalized.assignedBy) } : {}),
    ...(normalized.reason ? { reason: metadataDigest('route-reason', normalized.reason) } : {}),
    ...(normalized.selectedSkillIds
      ? { selectedSkillIds: normalized.selectedSkillIds.map((id) => metadataDigest('selected-skill-id', id)) }
      : {}),
    ...(normalized.skillPolicyVersion
      ? { skillPolicyVersion: metadataDigest('skill-policy-version', normalized.skillPolicyVersion) }
      : {}),
  };
}

function dispatchRunEventSummaryMetadata(input: RunEventSummary | undefined): RunEventSummary | undefined {
  const normalized = normalizeRunEventSummary(input);
  if (!normalized) return undefined;
  const contextSummary = normalized.contextSummary;
  const prompt = contextSummary?.prompt;
  const compression = contextSummary?.compression;
  return {
    ...normalized,
    ...(contextSummary
      ? {
        contextSummary: {
          ...contextSummary,
          ...(prompt
            ? {
              prompt: {
                ...prompt,
                ...(prompt.profileId
                  ? { profileId: metadataDigest('prompt-profile-id', prompt.profileId) }
                  : {}),
              },
            }
            : {}),
          ...(compression
            ? {
              compression: {
                ...compression,
                ...(compression.droppedLayers
                  ? {
                    droppedLayers: compression.droppedLayers.map((layer) =>
                      metadataDigest('compression-dropped-layer', layer)),
                  }
                  : {}),
              },
            }
            : {}),
        },
      }
      : {}),
  };
}

function dispatchEvidenceMetadata(input: EvidenceOutcomeSummary | undefined): EvidenceOutcomeSummary | undefined {
  if (!input) return undefined;
  return {
    ...(input.target ? { target: metadataDigest('evidence-target', input.target) } : {}),
    ...(input.trustBasis ? { trustBasis: metadataDigest('evidence-trust-basis', input.trustBasis) } : {}),
    ...(input.riskClass ? { riskClass: metadataDigest('evidence-risk-class', input.riskClass) } : {}),
    ...(typeof input.verificationPassed === 'boolean'
      ? { verificationPassed: input.verificationPassed }
      : {}),
    ...(typeof input.policyAllowed === 'boolean' ? { policyAllowed: input.policyAllowed } : {}),
    ...(input.policyAction ? { policyAction: metadataDigest('evidence-policy-action', input.policyAction) } : {}),
    ...(input.policyTier ? { policyTier: metadataDigest('evidence-policy-tier', input.policyTier) } : {}),
    ...(typeof input.gateCount === 'number' && Number.isFinite(input.gateCount)
      ? { gateCount: Math.max(0, input.gateCount) }
      : {}),
  };
}

export function trustedExecutionIdentity(value: unknown): string | undefined {
  return isSafeExecutionIdentity(value) && scrubSecrets(value) === value ? value : undefined;
}

function trustedRunTrajectory(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 240 || scrubSecrets(value) !== value) return undefined;
  return value.startsWith('run:') && isSafeExecutionIdentity(value.slice('run:'.length))
    ? value
    : undefined;
}

function dispatchCausalIdentities(event: DispatchProductionEvent): {
  attemptId?: string;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  runEventSummary?: RunEventSummary;
} {
  const attemptId = isOuterAttemptIdentity(event.attemptId) && scrubSecrets(event.attemptId) === event.attemptId
    ? event.attemptId
    : undefined;
  const proposalId = trustedExecutionIdentity(event.proposalId);
  const runId = trustedExecutionIdentity(event.runId);
  const trajectoryId = trustedRunTrajectory(event.trajectoryId);
  const rawSummary = event.runEventSummary;
  const summaryRunId = trustedExecutionIdentity(rawSummary?.runId);
  const summaryProposalId = trustedExecutionIdentity(rawSummary?.proposalId);
  const invalidOptionalIdentity =
    (event.proposalId !== undefined && proposalId === undefined) ||
    (rawSummary?.runId !== undefined && summaryRunId === undefined) ||
    (rawSummary?.proposalId !== undefined && summaryProposalId === undefined);
  const summarySemanticsAgree = rawSummary !== undefined &&
    summaryRunId === runId &&
    dispatchProductionRunStatusAgrees(event.outcome, rawSummary.status) &&
    rawSummary.outcome === event.outcome &&
    rawSummary.proposalCreated === Boolean(event.proposalCreated) &&
    summaryProposalId === proposalId;
  const identitiesAgree =
    attemptId !== undefined &&
    runId !== undefined &&
    trajectoryId === `run:${attemptId}` &&
    !invalidOptionalIdentity &&
    summarySemanticsAgree &&
    (summaryRunId === undefined || summaryRunId === runId) &&
    (summaryProposalId === undefined || summaryProposalId === proposalId);
  const safeSummary = rawSummary
    ? {
        ...rawSummary,
        runId: summaryRunId,
        proposalId: summaryProposalId,
      }
    : undefined;
  return {
    ...(identitiesAgree ? { attemptId } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...(trajectoryId ? { trajectoryId } : {}),
    ...(safeSummary ? { runEventSummary: safeSummary } : {}),
  };
}

export function dispatchProductionRunStatusForOutcome(
  outcome: DaemonDispatchProductionOutcome,
): 'done' | 'failed' | 'aborted' {
  if (outcome === 'cancelled') return 'aborted';
  if (
    outcome === 'engine-failed' ||
    outcome === 'sandbox-failed' ||
    outcome === 'proposal-capture-error'
  ) return 'failed';
  return 'done';
}

export function dispatchProductionRunStatusAgrees(
  outcome: DaemonDispatchProductionOutcome,
  status: unknown,
): status is 'done' | 'failed' | 'aborted' {
  if (outcome === 'cancelled') return status === 'aborted';
  if (outcome === 'proposal-created') {
    return status === 'done' || status === 'failed' || status === 'aborted';
  }
  if (
    outcome === 'engine-failed' ||
    outcome === 'sandbox-failed' ||
    outcome === 'proposal-capture-error' ||
    outcome === 'proposal-disabled'
  ) {
    return status === 'done' || status === 'failed' || status === 'aborted';
  }
  if (outcome === 'gate-blocked') return status === 'done' || status === 'failed' || status === 'aborted';
  return status === 'done';
}

export function canonicalDispatchRepoIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || !isAbsolute(value)) return null;
  if (scrubSecrets(value) !== value) return null;
  const canonical = canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
  return canonical !== null && canonical.length <= 500 && scrubSecrets(canonical) === canonical
    ? canonical
    : null;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

export function sanitizeDispatchProductionEvent(
  event: DispatchProductionEvent,
  opts: {
    materializeLearningLabel?: boolean;
    deriveLegacyRunOutcomeCausal?: boolean;
    preserveMissingCausalAuthority?: boolean;
  } = {},
): DispatchProductionEvent {
  const ts = eventTimestamp(event.ts);
  const machineId = boundedOptionalText(event.machineId, 120);
  const itemId = boundedText(event.itemId, 240) || 'unknown';
  const source = boundedText(event.source, 80) as WorkItem['source'];
  const repo = canonicalDispatchRepoIdentity(event.repo);
  if (repo === null) throw new Error('invalid dispatch production repository identity');
  const rawTitle = boundedText(event.title, 160) || 'untitled';
  const title = metadataDigest('title', event.title, 'untitled');
  const boundedBackend = boundedNullableText(event.backend, 80);
  const backend = boundedBackend === null || ENGINE_IDS.has(boundedBackend as EngineId)
    ? boundedBackend as EngineId | null
    : undefined;
  const boundedTier = boundedNullableText(event.tier, 40);
  const tier = boundedTier === null || ENGINE_TIERS.has(boundedTier as EngineTier)
    ? boundedTier as EngineTier | null
    : undefined;
  const model = boundedNullableText(event.model, 160) as string | null | undefined;
  const assignedBy = metadataDigest('assigned-by', event.assignedBy);
  const routeReason = metadataDigest('route-reason', event.routeReason);
  const identities = dispatchCausalIdentities(event);
  const { attemptId, proposalId, runId, trajectoryId } = identities;
  const boundedOutcome = boundedText(event.outcome, 80) as DaemonDispatchProductionOutcome;
  const outcome = DISPATCH_PRODUCTION_OUTCOMES.has(boundedOutcome) ? boundedOutcome : 'unknown';
  const boundedBasis = boundedText(event.basis, 80) as DispatchProductionBasis;
  const basis = DISPATCH_PRODUCTION_BASES.has(boundedBasis) ? boundedBasis : 'unknown';
  const routerPolicyVersion = boundedOptionalText(event.routerPolicyVersion, 80);
  const learningEpoch = boundedOptionalText(event.learningEpoch, 40);
  const objectiveHash = typeof event.objectiveHash === 'string' && /^[a-f0-9]{64}$/.test(event.objectiveHash)
    ? event.objectiveHash
    : undefined;
  const repairHandoffId = typeof event.repairHandoffId === 'string' && SHA256_RE.test(event.repairHandoffId)
    ? event.repairHandoffId
    : undefined;
  const repairGenerationId = typeof event.repairGenerationId === 'string' && SHA256_RE.test(event.repairGenerationId)
    ? event.repairGenerationId
    : undefined;
  const repairTreatmentUnitId = typeof event.repairTreatmentUnitId === 'string' && SHA256_RE.test(event.repairTreatmentUnitId)
    ? event.repairTreatmentUnitId
    : undefined;
  const repairTreatment = event.repairTreatment === 'baseline-reslice' || event.repairTreatment === 'target-localization'
    ? event.repairTreatment
    : undefined;
  const repairTreatmentOutcome = event.repairTreatmentOutcome === 'converted' ||
    event.repairTreatmentOutcome === 'not-converted'
    ? event.repairTreatmentOutcome
    : undefined;
  const repairTreatmentAttemptHash = typeof event.repairTreatmentAttemptHash === 'string' &&
    SHA256_RE.test(event.repairTreatmentAttemptHash)
    ? event.repairTreatmentAttemptHash
    : undefined;
  const repairAttemptOrdinal = event.repairAttemptOrdinal === 1 || event.repairAttemptOrdinal === 2
    ? event.repairAttemptOrdinal
    : undefined;
  const repairPreviousBackend = ENGINE_IDS.has(event.repairPreviousBackend as EngineId)
    ? event.repairPreviousBackend
    : undefined;
  const repairRootId = typeof event.repairRootId === 'string' && SHA256_RE.test(event.repairRootId)
    ? event.repairRootId
    : undefined;
  const repairDepth = event.repairDepth === 0 || event.repairDepth === 1
    ? event.repairDepth
    : undefined;
  const repairLineageFieldsPresent = event.repairHandoffId !== undefined ||
    event.repairGenerationId !== undefined ||
    event.repairTreatmentUnitId !== undefined ||
    event.repairTreatment !== undefined ||
    event.repairTreatmentOutcome !== undefined ||
    event.repairTreatmentAttemptHash !== undefined ||
    event.repairAttemptOrdinal !== undefined ||
    event.repairPreviousBackend !== undefined ||
    event.repairRootId !== undefined ||
    event.repairDepth !== undefined;
  const diagnosticRepairLineage = repairTreatmentUnitId !== undefined && repairTreatment !== undefined &&
    /:proposal-repair-nodiff:[0-9a-f]{12}$/i.test(itemId) &&
    repairTreatmentForUnitId(repairTreatmentUnitId) === repairTreatment;
  const genericRepairLineage = repairTreatmentUnitId === undefined && repairTreatment === undefined &&
    /:proposal-repair(?:-capture)?:[0-9a-f]{12}$/i.test(itemId) &&
    repairRootId !== undefined && repairDepth !== undefined;
  const legacyRepairLineage = repairTreatmentUnitId === undefined && repairTreatment === undefined &&
    repairRootId === undefined && repairDepth === undefined;
  const repairLineageComplete = event.repairLineageInvalid !== true &&
    backend !== undefined &&
    backend !== null &&
    ENGINE_IDS.has(backend) &&
    repairGenerationId !== undefined &&
    ((diagnosticRepairLineage &&
      repairHandoffId !== undefined &&
      repairGenerationIdFromHandoffId(repairHandoffId) === repairGenerationId &&
      (ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(outcome)
        ? repairRootId !== undefined && repairDepth !== undefined
        : repairRootId === undefined && repairDepth === undefined)) || genericRepairLineage ||
      (legacyRepairLineage && repairHandoffId !== undefined &&
        repairGenerationIdFromHandoffId(repairHandoffId) === repairGenerationId)) &&
    repairAttemptOrdinal !== undefined &&
    (repairAttemptOrdinal === 1
      ? repairPreviousBackend === undefined
      : repairPreviousBackend !== undefined && backend !== repairPreviousBackend);
  const lifecycleAttemptId = trajectoryId !== undefined && runId !== undefined &&
    trajectoryId === `run:${runId}` && repairTreatmentAttemptHash !== undefined &&
    generatedRepairLifecycleAttemptHash(runId) === repairTreatmentAttemptHash
    ? runId
    : trajectoryId ?? runId;
  const repairTreatmentOutcomeComplete = repairTreatmentOutcome !== undefined &&
    basis === 'repair-lifecycle-outcome' &&
    repairTreatmentAttemptHash !== undefined &&
    lifecycleAttemptId !== undefined &&
    generatedRepairLifecycleAttemptHash(lifecycleAttemptId) === repairTreatmentAttemptHash &&
    repairTreatmentUnitId !== undefined &&
    repairTreatment !== undefined &&
    repairGenerationId !== undefined &&
    (repairTreatmentOutcome === 'converted'
      ? outcome === 'proposal-created' && Boolean(event.proposalCreated) && proposalId !== undefined
      : outcome === 'empty-diff' && !event.proposalCreated && proposalId === undefined && repairAttemptOrdinal === 2);
  const repairTreatmentCandidateComplete = repairTreatmentOutcome === undefined &&
    basis === 'repair-lifecycle-candidate' &&
    repairTreatmentAttemptHash !== undefined &&
    lifecycleAttemptId !== undefined &&
    generatedRepairLifecycleAttemptHash(lifecycleAttemptId) === repairTreatmentAttemptHash &&
    repairTreatmentUnitId !== undefined &&
    repairTreatment !== undefined &&
    repairGenerationId !== undefined;
  const repairLineageInvalid = event.repairLineageInvalid === true ||
    (repairLineageFieldsPresent && !repairLineageComplete) ||
    ((basis === 'repair-lifecycle-candidate' || basis === 'repair-lifecycle-outcome' ||
      event.repairTreatmentOutcome !== undefined ||
      event.repairTreatmentAttemptHash !== undefined) &&
      !repairTreatmentOutcomeComplete && !repairTreatmentCandidateComplete);
  const rawReason = boundedOptionalText(event.reason, 240);
  const reason = optionalMetadataDigest('reason', event.reason);
  const diffFiles = finiteNonNegative(event.diffFiles);
  const diffLines = finiteNonNegative(event.diffLines);
  const spentUsd = finiteNonNegative(event.spentUsd) ?? 0;
  const legacyCausal =
    opts.deriveLegacyRunOutcomeCausal && basis === 'run-proposal-outcome'
      ? legacyRunOutcomeCausalFallback({
          backend,
          tier,
          model,
          assignedBy: boundedOptionalText(event.assignedBy, 80),
          routeReason: boundedOptionalText(event.routeReason, 240),
          runId,
          outcome,
          proposalCreated: Boolean(event.proposalCreated),
          proposalId,
          diffFiles,
          diffLines,
          spentUsd: finiteNonNegative(event.spentUsd),
        })
      : {};
  const causal: Partial<ReturnType<typeof causalMetadata>> = causalMetadata({
    ts,
    itemId,
    proposalId,
    runId,
    trajectoryId,
    routeSnapshot: event.routeSnapshot ?? legacyCausal.routeSnapshot,
    runEventSummary: identities.runEventSummary ?? legacyCausal.runEventSummary,
    evidenceOutcome: event.evidenceOutcome,
    learningSource: event.learningSource ??
      (opts.preserveMissingCausalAuthority ? undefined : 'daemon-dispatch'),
    labelBasis: event.labelBasis ??
      (opts.preserveMissingCausalAuthority ? undefined : 'dispatch-outcome'),
    routerPolicyVersion,
    learningEpoch,
  });
  const metadataRoute = dispatchRouteSnapshotMetadata(causal.routeSnapshot);
  const metadataRunSummary = dispatchRunEventSummaryMetadata(causal.runEventSummary);
  const metadataEvidence = dispatchEvidenceMetadata(causal.evidenceOutcome);
  if (metadataRoute) causal.routeSnapshot = metadataRoute;
  else delete causal.routeSnapshot;
  if (metadataRunSummary) causal.runEventSummary = metadataRunSummary;
  else delete causal.runEventSummary;
  if (metadataEvidence) causal.evidenceOutcome = metadataEvidence;
  else delete causal.evidenceOutcome;
  const legacyTreatmentTrajectoryAllowed =
    (basis === 'repair-lifecycle-candidate' || basis === 'repair-lifecycle-outcome') &&
    runId !== undefined;
  if (trajectoryId === undefined && !legacyTreatmentTrajectoryAllowed) delete causal.trajectoryId;
  if (opts.preserveMissingCausalAuthority) {
    if (
      routerPolicyVersion === undefined &&
      event.routeSnapshot?.routerPolicyVersion === undefined
    ) delete causal.routerPolicyVersion;
    if (learningEpoch === undefined) delete causal.learningEpoch;
  }
  const storedLearningLabel = sanitizeProductionAttemptLearningLabel(event.learningLabel);
  const canonicalNarrative = METADATA_DIGEST_RE.test(event.title) &&
    METADATA_DIGEST_RE.test(event.assignedBy) &&
    METADATA_DIGEST_RE.test(event.routeReason) &&
    (event.reason === undefined || METADATA_DIGEST_RE.test(event.reason));
  const learningLabel = opts.materializeLearningLabel && !(canonicalNarrative && storedLearningLabel)
    ? productionAttemptLearningLabelFromSignals({
        outcome,
        proposalCreated: Boolean(event.proposalCreated),
        actionCounts: causal.runEventSummary?.actionCounts,
        reason: rawReason,
        itemId,
        title: rawTitle,
        source,
      })
    : storedLearningLabel;
  return {
    schemaVersion: causal.runEventSummary?.tokenEvidence ? 2 : 1,
    ts,
    ...(machineId ? { machineId } : {}),
    itemId,
    source,
    repo,
    title,
    backend: backend ?? null,
    tier: tier ?? null,
    ...(model !== undefined ? { model } : {}),
    assignedBy,
    routeReason,
    outcome,
    proposalCreated: Boolean(event.proposalCreated),
    ...(proposalId ? { proposalId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(runId ? { runId } : {}),
    ...causal,
    ...(learningLabel ? { learningLabel } : {}),
    ...(objectiveHash ? { objectiveHash } : {}),
    ...(repairLineageInvalid
      ? {
        repairLineageInvalid: true as const,
        ...(repairGenerationId && repairAttemptOrdinal
          ? { repairGenerationId, repairAttemptOrdinal }
          : {}),
      }
      : repairLineageComplete
        ? {
          ...(repairHandoffId ? { repairHandoffId } : {}),
          repairGenerationId,
          ...(repairTreatmentUnitId ? { repairTreatmentUnitId } : {}),
          ...(repairTreatment ? { repairTreatment } : {}),
          ...(repairTreatmentOutcomeComplete || repairTreatmentCandidateComplete ? {
            ...(repairTreatmentOutcome ? { repairTreatmentOutcome } : {}),
            repairTreatmentAttemptHash,
          } : {}),
          repairAttemptOrdinal,
          ...(repairPreviousBackend ? { repairPreviousBackend } : {}),
          ...(repairRootId ? { repairRootId, repairDepth } : {}),
          }
        : {}),
    spentUsd,
    ...(diffFiles !== undefined ? { diffFiles } : {}),
    ...(diffLines !== undefined ? { diffLines } : {}),
    ...(reason ? { reason } : {}),
    basis,
  };
}

function legacyRunOutcomeCausalFallback(input: {
  backend?: EngineId | null;
  tier?: EngineTier | null;
  model?: string | null;
  assignedBy?: string;
  routeReason?: string;
  runId?: string;
  outcome?: DaemonDispatchProductionOutcome;
  proposalCreated?: boolean;
  proposalId?: string;
  diffFiles?: number;
  diffLines?: number;
  spentUsd?: number;
}): { routeSnapshot?: RouteSnapshot; runEventSummary?: RunEventSummary } {
  const routeSnapshot: RouteSnapshot = {
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.assignedBy ? { assignedBy: input.assignedBy } : {}),
    ...(input.routeReason ? { reason: input.routeReason } : {}),
  };
  const runEventSummary: RunEventSummary = {
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.proposalCreated !== undefined ? { proposalCreated: input.proposalCreated } : {}),
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    ...(input.diffFiles !== undefined ? { diffFiles: input.diffFiles } : {}),
    ...(input.diffLines !== undefined ? { diffLines: input.diffLines } : {}),
    ...(input.spentUsd !== undefined ? { costUsd: input.spentUsd } : {}),
  };
  return {
    ...(Object.keys(routeSnapshot).length > 0 ? { routeSnapshot } : {}),
    ...(Object.keys(runEventSummary).length > 0 ? { runEventSummary } : {}),
  };
}

export function isDispatchProductionEvent(value: unknown): value is DispatchProductionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    (obj['schemaVersion'] === 1 || obj['schemaVersion'] === 2) &&
    tokenEnvelopeCurrent(obj, true) &&
    typeof obj['ts'] === 'string' &&
    typeof obj['itemId'] === 'string' &&
    typeof obj['source'] === 'string' &&
    typeof obj['repo'] === 'string' && canonicalDispatchRepoIdentity(obj['repo']) === obj['repo'] &&
    typeof obj['title'] === 'string' &&
    typeof obj['assignedBy'] === 'string' &&
    typeof obj['routeReason'] === 'string' &&
    typeof obj['outcome'] === 'string' &&
    typeof obj['proposalCreated'] === 'boolean' &&
    typeof obj['spentUsd'] === 'number' &&
    typeof obj['basis'] === 'string'
  );
}

export function proposalActionCountsForOutcome(event: Pick<DispatchProductionEvent, 'outcome' | 'proposalCreated'>): {
  proposalCreated: 0 | 1;
  proposalBlocked: 0 | 1;
  proposalDisabled: 0 | 1;
} {
  return {
    proposalCreated: event.proposalCreated ? 1 : 0,
    proposalBlocked: event.outcome === 'gate-blocked' || event.outcome === 'proposal-capture-error' ? 1 : 0,
    proposalDisabled: event.outcome === 'proposal-disabled' ? 1 : 0,
  };
}

function validActionCountValues(actionCounts: RunActionCounts | undefined): boolean {
  if (actionCounts === undefined) return true;
  if (typeof actionCounts !== 'object' || Array.isArray(actionCounts)) return false;
  return RUN_ACTION_COUNT_KEYS.every((key) => {
    const value = actionCounts[key];
    return value === undefined || (Number.isSafeInteger(value) && value >= 0);
  });
}

function coherentStepCounts(actionCounts: RunActionCounts | undefined): boolean {
  if (!actionCounts) return true;
  const { modelSteps, toolSteps, totalSteps } = actionCounts;
  if (totalSteps === undefined) return true;
  if (modelSteps !== undefined && totalSteps < modelSteps) return false;
  if (toolSteps !== undefined && totalSteps < toolSteps) return false;
  return modelSteps === undefined || toolSteps === undefined || totalSteps === modelSteps + toolSteps;
}

export function actionCountsAgreeWithOutcome(
  event: Pick<DispatchProductionEvent, 'outcome' | 'proposalCreated' | 'diffFiles' | 'diffLines'>,
  actionCounts: RunActionCounts | undefined,
): boolean {
  if (!validActionCountValues(actionCounts) || !coherentStepCounts(actionCounts)) return false;
  if (!actionCounts) return true;
  const expected = proposalActionCountsForOutcome(event);
  if (
    (actionCounts.proposalCreated !== undefined &&
      actionCounts.proposalCreated !== expected.proposalCreated) ||
    (actionCounts.proposalBlocked !== undefined &&
      actionCounts.proposalBlocked !== expected.proposalBlocked) ||
    (actionCounts.proposalDisabled !== undefined &&
      actionCounts.proposalDisabled !== expected.proposalDisabled) ||
    (actionCounts.proposalBlocked ?? 0) +
      (actionCounts.proposalCreated ?? 0) +
      (actionCounts.proposalDisabled ?? 0) > 1 ||
    (actionCounts.diffFiles !== undefined && actionCounts.diffFiles !== event.diffFiles) ||
    (actionCounts.diffLines !== undefined && actionCounts.diffLines !== event.diffLines)
  ) return false;
  return event.outcome !== 'cancelled' || (actionCounts.proposalBlocked ?? 0) === 0;
}

function suppliedDuplicatedFieldsAgree(
  outer: Record<string, unknown>,
  nested: Record<string, unknown>,
  excluded: ReadonlySet<string> = new Set(),
): boolean {
  return Object.entries(nested).every(([key, value]) =>
    value === undefined || excluded.has(key) || outer[key] === undefined || isDeepStrictEqual(outer[key], value));
}

function suppliedAliasAgrees(
  outer: Record<string, unknown>,
  outerKey: string,
  nested: Record<string, unknown>,
  nestedKey: string,
): boolean {
  return outer[outerKey] === undefined || nested[nestedKey] === undefined ||
    isDeepStrictEqual(outer[outerKey], nested[nestedKey]);
}

export function dispatchProductionSuppliedEnvelopeSemanticsAgree(event: DispatchProductionEvent): boolean {
  if (event.proposalCreated !== (event.outcome === 'proposal-created')) return false;
  const raw = event as unknown as Record<string, unknown>;
  const rawSummary = raw['runEventSummary'];
  const derivedLifecycle = event.basis === 'repair-lifecycle-candidate' ||
    event.basis === 'repair-lifecycle-outcome';
  if (rawSummary !== undefined && (!isPlainRecord(rawSummary) || (!derivedLifecycle &&
    (!suppliedDuplicatedFieldsAgree(raw, rawSummary) ||
      !suppliedAliasAgrees(raw, 'spentUsd', rawSummary, 'costUsd'))))) return false;

  const rawRoute = raw['routeSnapshot'];
  if (!derivedLifecycle && rawRoute !== undefined) {
    const incompleteLegacyEnvelope = isPreEnvelopeDispatchProductionEvent(event);
    if (!isPlainRecord(rawRoute) ||
      !suppliedDuplicatedFieldsAgree(raw, rawRoute, new Set(['reason'])) ||
      (incompleteLegacyEnvelope &&
        !suppliedAliasAgrees(raw, 'routeReason', rawRoute, 'reason'))) return false;
  }
  if (raw['attemptId'] !== undefined && raw['trajectoryId'] !== undefined &&
    raw['trajectoryId'] !== `run:${String(raw['attemptId'])}`) return false;

  if (rawSummary === undefined) return true;

  const summary = rawSummary as RunEventSummary;
  const actionCounts = summary.actionCounts;
  if (!validActionCountValues(actionCounts) || !coherentStepCounts(actionCounts)) return false;
  if (isPlainRecord(actionCounts) && !suppliedDuplicatedFieldsAgree(
    rawSummary,
    actionCounts,
    new Set(['proposalCreated', 'proposalBlocked', 'proposalDisabled']),
  )) return false;
  if (summary.status !== undefined && !dispatchProductionRunStatusAgrees(event.outcome, summary.status)) return false;
  if (summary.outcome !== undefined && summary.outcome !== event.outcome) return false;
  if (summary.proposalCreated !== undefined && summary.proposalCreated !== event.proposalCreated) return false;
  return actionCountsAgreeWithOutcome(event, actionCounts);
}

export function materializeDispatchProductionAttemptEnvelope(
  event: DispatchProductionEvent,
): DispatchProductionEvent {
  const attemptId = event.attemptId ??
    (event.trajectoryId === `run:${event.runId}` && isOuterAttemptIdentity(event.runId)
      ? event.runId
      : undefined);
  const trajectoryId = event.trajectoryId ?? (attemptId ? `run:${attemptId}` : undefined);
  if (event.proposalCreated !== (event.outcome === 'proposal-created')) {
    throw new Error('dispatch production outcome contradicts proposal creation');
  }
  const summary = event.runEventSummary ?? {};
  const suppliedCounts = summary.actionCounts;
  if (!validActionCountValues(suppliedCounts) || !coherentStepCounts(suppliedCounts)) {
    throw new Error('dispatch production action counts are invalid');
  }
  if (summary.runId !== undefined && summary.runId !== event.runId) {
    throw new Error('dispatch production run identity mismatch');
  }
  if (summary.status !== undefined && !dispatchProductionRunStatusAgrees(event.outcome, summary.status)) {
    throw new Error('dispatch production run status mismatch');
  }
  if (summary.outcome !== undefined && summary.outcome !== event.outcome) {
    throw new Error('dispatch production summary outcome mismatch');
  }
  if (summary.proposalCreated !== undefined && summary.proposalCreated !== event.proposalCreated) {
    throw new Error('dispatch production summary proposal mismatch');
  }
  if (summary.proposalId !== undefined && summary.proposalId !== event.proposalId) {
    throw new Error('dispatch production summary proposal identity mismatch');
  }
  if (summary.costUsd !== undefined && summary.costUsd !== event.spentUsd) {
    throw new Error('dispatch production summary spend mismatch');
  }

  const diffFiles = event.diffFiles ?? summary.diffFiles ?? suppliedCounts?.diffFiles;
  const diffLines = event.diffLines ?? summary.diffLines ?? suppliedCounts?.diffLines;
  if (event.outcome === 'empty-diff' && ((diffFiles ?? 0) !== 0 || (diffLines ?? 0) !== 0)) {
    throw new Error('empty dispatch outcome contradicts diff counts');
  }
  if (
    (event.diffFiles !== undefined && diffFiles !== event.diffFiles) ||
    (summary.diffFiles !== undefined && diffFiles !== summary.diffFiles) ||
    (suppliedCounts?.diffFiles !== undefined && diffFiles !== suppliedCounts.diffFiles) ||
    (event.diffLines !== undefined && diffLines !== event.diffLines) ||
    (summary.diffLines !== undefined && diffLines !== summary.diffLines) ||
    (suppliedCounts?.diffLines !== undefined && diffLines !== suppliedCounts.diffLines)
  ) {
    throw new Error('dispatch production diff counts mismatch');
  }

  const expectedProposalCounts = proposalActionCountsForOutcome(event);
  if (!actionCountsAgreeWithOutcome(
    { ...event, diffFiles, diffLines },
    suppliedCounts,
  )) throw new Error('dispatch production action counts contradict outcome');
  const actionCounts: RunActionCounts = {
    ...(suppliedCounts ?? {}),
    ...expectedProposalCounts,
    ...(diffFiles !== undefined ? { diffFiles } : {}),
    ...(diffLines !== undefined ? { diffLines } : {}),
  };
  if (
    actionCounts.totalSteps === undefined &&
    actionCounts.modelSteps !== undefined &&
    actionCounts.toolSteps !== undefined
  ) {
    actionCounts.totalSteps = actionCounts.modelSteps + actionCounts.toolSteps;
  }

  return {
    ...event,
    ...(attemptId ? { attemptId } : {}),
    ...(trajectoryId ? { trajectoryId } : {}),
    ...(diffFiles !== undefined ? { diffFiles } : {}),
    ...(diffLines !== undefined ? { diffLines } : {}),
    runEventSummary: {
      ...summary,
      runId: event.runId,
      status: summary.status ?? dispatchProductionRunStatusForOutcome(event.outcome),
      outcome: event.outcome,
      proposalCreated: event.proposalCreated,
      proposalId: event.proposalId,
      ...(diffFiles !== undefined ? { diffFiles } : {}),
      ...(diffLines !== undefined ? { diffLines } : {}),
      costUsd: event.spentUsd,
      actionCounts,
    },
  };
}
