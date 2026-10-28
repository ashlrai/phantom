/** Canonical attempt accounting and production yield summaries. */

import type {
  DispatchProductionOutcomeCounts,
  DispatchProductionEvent,
  CanonicalDispatchProductionAttempts,
  DispatchProductionReasonCount,
  GeneratedRepairAttemptSummary,
  RepairTreatmentConversionSummary,
  RepairTreatmentAttributionSummary,
  RepairTreatmentAttributionArmSummary,
  RepairTreatmentAttributionBlocker,
  DispatchProductionYieldBucket,
  GeneratedRepairBackendTransitionSummary,
  GeneratedRepairBackendTransitionBucket,
  DispatchProductionYieldSummary,
  DispatchProductionYieldReadResult,
  DispatchProductionSourceQuality,
} from './types.js';
import type {
  RunActionCounts,
  DaemonDispatchProductionOutcome,
  EngineId,
  WorkItem,
  ProductionAttemptShape,
  RepairTreatment,
} from '../../types.js';
import {
  classifyProductionAttemptForLearningWithLabel,
  type ProductionAttemptLearningClassification,
  type GeneratedRepairAttemptKind,
  generatedRepairAttemptKindFromSignals,
  emptyProductionAttemptShape,
  addProductionAttemptShape,
  hasProductionAttemptShape,
} from '../../learning/attempt-shape.js';
import { diagnosticDispatchProductionLearningLabel } from './attempt-proofs.js';
import { isOuterAttemptIdentity } from '../attempt-identity.js';
import { scrubSecrets } from '../../util/scrub.js';
import {
  trustedExecutionIdentity,
  proposalActionCountsForOutcome,
  dispatchProductionRunStatusAgrees,
  actionCountsAgreeWithOutcome,
  dispatchProductionSuppliedEnvelopeSemanticsAgree,
  sanitizeDispatchProductionEvent,
} from './events.js';
import {
  repairGenerationIdFromHandoffId,
  repairTreatmentForUnitId,
  generatedRepairLifecycleAttemptHash,
  REPAIR_TREATMENTS,
} from '../generated-repair-identity.js';
import { MIN_REPAIR_TREATMENT_ATTEMPTS, SHA256_RE, ENGINE_IDS, DAY_MS } from './constants.js';
import { readDispatchProductionEventsDetailed } from './read.js';

function emptyOutcomeCounts(): DispatchProductionOutcomeCounts {
  return {
    proposalCreated: 0,
    emptyDiff: 0,
    gateBlocked: 0,
    engineFailed: 0,
    cancelled: 0,
    sandboxFailed: 0,
    proposalCaptureError: 0,
    proposalDisabled: 0,
    unknown: 0,
  };
}

export const RUN_ACTION_COUNT_KEYS = [
  'sandboxCreated',
  'spawnAttempts',
  'transientRetries',
  'proposalCaptureAttempts',
  'completenessGateRuns',
  'verifyRepairAttempts',
  'modelSteps',
  'toolSteps',
  'totalSteps',
  'diffFiles',
  'diffLines',
  'proposalCreated',
  'proposalBlocked',
  'proposalDisabled',
] as const satisfies readonly (keyof RunActionCounts)[];

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function addRunActionCounts(target: RunActionCounts, source: RunActionCounts | undefined): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  const record = source as Record<string, unknown>;
  for (const key of RUN_ACTION_COUNT_KEYS) {
    const value = nonNegativeInteger(record[key]);
    if (value === undefined || value <= 0) continue;
    target[key] = Math.min((target[key] ?? 0) + value, Number.MAX_SAFE_INTEGER);
  }
}

function hasRunActionCounts(counts: RunActionCounts): boolean {
  return RUN_ACTION_COUNT_KEYS.some((key) => (counts[key] ?? 0) > 0);
}

function incrementOutcome(
  counts: DispatchProductionOutcomeCounts,
  outcome: DaemonDispatchProductionOutcome | 'cancelled',
): void {
  switch (outcome) {
    case 'proposal-created':
      counts.proposalCreated++;
      break;
    case 'empty-diff':
      counts.emptyDiff++;
      break;
    case 'gate-blocked':
      counts.gateBlocked++;
      break;
    case 'engine-failed':
      counts.engineFailed++;
      break;
    case 'cancelled':
      counts.cancelled = (counts.cancelled ?? 0) + 1;
      break;
    case 'sandbox-failed':
      counts.sandboxFailed++;
      break;
    case 'proposal-capture-error':
      counts.proposalCaptureError++;
      break;
    case 'proposal-disabled':
      counts.proposalDisabled++;
      break;
    default:
      counts.unknown++;
      break;
  }
}

export function isCancelledDispatchProductionEvent(event: DispatchProductionEvent): boolean {
  if (String(event.outcome).trim().toLowerCase() === 'cancelled') return true;
  const classification = classifyProductionAttemptForLearningWithLabel({
    outcome: event.outcome,
    proposalCreated: event.proposalCreated,
    actionCounts: event.runEventSummary?.actionCounts,
    reason: event.reason ?? event.routeReason,
    itemId: event.itemId,
    title: event.title,
    source: event.source,
  }, diagnosticDispatchProductionLearningLabel(event));
  return String(classification.kind) === 'cancelled';
}

function canonicalAttemptIdentity(event: DispatchProductionEvent): string | null {
  if (!isOuterAttemptIdentity(event.attemptId) || scrubSecrets(event.attemptId) !== event.attemptId) {
    return null;
  }
  if (!trustedExecutionIdentity(event.runId) || event.trajectoryId !== `run:${event.attemptId}`) {
    return null;
  }
  if (event.proposalId !== undefined && !trustedExecutionIdentity(event.proposalId)) return null;
  const summary = event.runEventSummary;
  const actionCounts = summary?.actionCounts;
  const expectedProposalCounts = proposalActionCountsForOutcome(event);
  if (
    summary === undefined ||
    summary.runId !== event.runId ||
    !dispatchProductionRunStatusAgrees(event.outcome, summary.status) ||
    summary.outcome !== event.outcome ||
    event.proposalCreated !== (event.outcome === 'proposal-created') ||
    summary.proposalCreated !== event.proposalCreated ||
    summary.proposalId !== event.proposalId ||
    summary.diffFiles !== event.diffFiles ||
    summary.diffLines !== event.diffLines ||
    summary.costUsd !== event.spentUsd ||
    !actionCountsAgreeWithOutcome(event, actionCounts) ||
    (actionCounts?.proposalCreated !== undefined &&
      actionCounts.proposalCreated !== expectedProposalCounts.proposalCreated) ||
    (actionCounts?.proposalDisabled !== undefined &&
      actionCounts.proposalDisabled !== expectedProposalCounts.proposalDisabled)
  ) return null;
  return event.attemptId;
}

export function isPreEnvelopeDispatchProductionEvent(event: DispatchProductionEvent): boolean {
  const summary = event.runEventSummary;
  const actionCounts = summary?.actionCounts;
  return event.attemptId === undefined ||
    event.runId === undefined ||
    event.trajectoryId === undefined ||
    summary === undefined ||
    summary.runId === undefined ||
    summary.status === undefined ||
    summary.outcome === undefined ||
    summary.proposalCreated === undefined ||
    summary.costUsd === undefined ||
    actionCounts === undefined ||
    actionCounts.proposalCreated === undefined ||
    actionCounts.proposalBlocked === undefined ||
    actionCounts.proposalDisabled === undefined ||
    (actionCounts.modelSteps !== undefined &&
      actionCounts.toolSteps !== undefined && actionCounts.totalSteps === undefined);
}

function canonicalAttemptSignature(event: DispatchProductionEvent): string {
  const { machineId: _machineId, ...semantic } = event;
  return JSON.stringify(semantic);
}

/** Canonical owner-writable attempt accounting shared by every public yield projection. */
export function canonicalDispatchProductionAttempts(
  rows: readonly DispatchProductionEvent[],
): CanonicalDispatchProductionAttempts {
  const identities = new Map<string, { event: DispatchProductionEvent; signature: string }>();
  const conflicts = new Set<string>();
  let preEnvelopeEvents = 0;
  let duplicateEvents = 0;
  let invalidAttemptIdentities = 0;
  for (const row of rows) {
    if (!dispatchProductionSuppliedEnvelopeSemanticsAgree(row)) {
      invalidAttemptIdentities++;
      continue;
    }
    const preEnvelope = isPreEnvelopeDispatchProductionEvent(row);
    let event: DispatchProductionEvent;
    try {
      event = sanitizeDispatchProductionEvent(row, {
        materializeLearningLabel: row.learningLabel === undefined,
        preserveMissingCausalAuthority: true,
      });
      if (row.labelOrigin === 'stored-current' || row.labelOrigin === 'stored-legacy' ||
        row.labelOrigin === 'derived-on-read') {
        event = { ...event, labelOrigin: row.labelOrigin };
      }
    } catch {
      invalidAttemptIdentities++;
      continue;
    }
    if (preEnvelope) {
      preEnvelopeEvents++;
      continue;
    }
    const identity = canonicalAttemptIdentity(event);
    if (identity === null) {
      invalidAttemptIdentities++;
      continue;
    }
    const signature = canonicalAttemptSignature(event);
    const existing = identities.get(identity);
    if (!existing) identities.set(identity, { event, signature });
    else if (existing.signature === signature) duplicateEvents++;
    else conflicts.add(identity);
  }
  return {
    events: [...identities.entries()]
      .filter(([identity]) => !conflicts.has(identity))
      .map(([, { event }]) => event),
    preEnvelopeEvents,
    duplicateEvents,
    invalidAttemptIdentities,
    conflictingAttemptIdentities: conflicts.size,
  };
}

function outcomeForAccounting(
  event: DispatchProductionEvent,
): DaemonDispatchProductionOutcome | 'cancelled' {
  return isCancelledDispatchProductionEvent(event) ? 'cancelled' : event.outcome;
}

function sortedReasons(reasons: Map<string, number>, limit: number): DispatchProductionReasonCount[] {
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function isSuppressedDispatchProductionReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? '').trim().toLowerCase();
  return normalized.startsWith('proposal-disabled') ||
    normalized.includes('proposal filing disabled');
}

function addDiagnosticReason(
  reasons: Map<string, number>,
  reason: string,
  classification: ProductionAttemptLearningClassification,
): void {
  if (!classification.diagnosticAttempt || isSuppressedDispatchProductionReason(reason)) return;
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

function dispatchReasonCode(
  event: DispatchProductionEvent,
  classification: ProductionAttemptLearningClassification,
): string {
  return event.outcome === 'proposal-disabled' && classification.diagnosticAttempt &&
    !classification.policySuppressed
    ? 'proposal-capture-missing'
    : event.outcome;
}

interface MutableYieldBucket {
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  repo?: string;
  model?: string | null;
  attempts: number;
  proposalsCreated: number;
  diagnosticAttempts: number;
  diagnosticProposalsCreated: number;
  diagnosticNoProposal: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts: RunActionCounts;
  attemptShape: ProductionAttemptShape;
  generatedRepairAttempts: GeneratedRepairAttemptSummary;
  repairTreatments: MutableRepairTreatmentAttribution;
  reasons: Map<string, number>;
  diagnosticReasons: Map<string, number>;
}

interface MutableRepairTreatmentAttribution {
  eligibleEvents: number;
  attributedEvents: number;
  unattributedEvents: number;
  replayedEvents: number;
  units: Map<RepairTreatment, Map<string, MutableRepairTreatmentUnit>>;
}

interface MutableRepairTreatmentUnit {
  rawAttempts: Map<string, string>;
  rawOrdinals: Set<1 | 2>;
  witness?: {
    executionKey: string;
    generationId: string;
    converted: boolean;
  };
  witnessEvents: number;
}

function emptyRepairTreatmentAttribution(): MutableRepairTreatmentAttribution {
  return {
    eligibleEvents: 0,
    attributedEvents: 0,
    unattributedEvents: 0,
    replayedEvents: 0,
    units: new Map(),
  };
}

function emptyGeneratedRepairAttemptSummary(): GeneratedRepairAttemptSummary {
  return {
    attempts: 0,
    proposalsCreated: 0,
    noProposal: 0,
    proposalRate: 0,
    captureRepairs: 0,
    diagnosticReslices: 0,
    proposalRepairs: 0,
  };
}

function hasGeneratedRepairAttemptSummary(summary: GeneratedRepairAttemptSummary): boolean {
  return summary.attempts > 0 ||
    summary.proposalsCreated > 0 ||
    summary.noProposal > 0 ||
    summary.captureRepairs > 0 ||
    summary.diagnosticReslices > 0 ||
    summary.proposalRepairs > 0;
}

function addGeneratedRepairAttempt(
  summary: GeneratedRepairAttemptSummary,
  kind: GeneratedRepairAttemptKind | undefined,
  proposalCreated: boolean,
  cancelled: boolean,
): void {
  if (!kind || cancelled) return;
  summary.attempts++;
  if (proposalCreated) summary.proposalsCreated++;
  else summary.noProposal++;
  summary.proposalRate = summary.attempts > 0 ? summary.proposalsCreated / summary.attempts : 0;
  if (kind === 'capture-repair') summary.captureRepairs++;
  else if (kind === 'no-diff-reslice') summary.diagnosticReslices++;
  else summary.proposalRepairs++;
}

function addRepairTreatmentAttempt(
  attribution: MutableRepairTreatmentAttribution,
  event: DispatchProductionEvent,
): void {
  if (isCancelledDispatchProductionEvent(event)) return;
  const kind = generatedRepairAttemptKindFromSignals({
    itemId: event.itemId,
    title: event.title,
    source: event.source,
  });
  if (kind !== 'no-diff-reslice') return;
  if (event.basis === 'repair-lifecycle-candidate') return;
  const terminalWitness = event.basis === 'repair-lifecycle-outcome';
  if (!terminalWitness) attribution.eligibleEvents++;
  const treatment = event.repairTreatment;
  const unitId = event.repairTreatmentUnitId;
  // Treatment receipts predate writer-issued attempt IDs and are named from the
  // validated run identity. Never join through a mutable trajectory alias.
  const executionId = event.runId ?? event.attemptId;
  if (
    !treatment ||
    !unitId ||
    !executionId ||
    event.repairLineageInvalid === true ||
    typeof event.repairHandoffId !== 'string' ||
    typeof event.repairGenerationId !== 'string' ||
    repairGenerationIdFromHandoffId(event.repairHandoffId) !== event.repairGenerationId ||
    repairTreatmentForUnitId(unitId) !== treatment ||
    !/:proposal-repair-nodiff:[0-9a-f]{12}$/i.test(event.itemId)
  ) {
    attribution.unattributedEvents++;
    return;
  }
  const units = attribution.units.get(treatment) ?? new Map<string, MutableRepairTreatmentUnit>();
  const unit: MutableRepairTreatmentUnit = units.get(unitId) ?? {
    rawAttempts: new Map(),
    rawOrdinals: new Set(),
    witnessEvents: 0,
  };
  const attemptHash = generatedRepairLifecycleAttemptHash(executionId);
  if (terminalWitness && (
    event.repairTreatmentOutcome === undefined ||
    event.repairTreatmentAttemptHash !== attemptHash
  )) {
    attribution.unattributedEvents++;
    return;
  }
  const executionKey = `${event.repairGenerationId}:${attemptHash}`;
  if (terminalWitness) {
    unit.witnessEvents++;
    if (unit.witnessEvents > 1 || unit.witness !== undefined) attribution.replayedEvents++;
    if (!unit.witness) {
      unit.witness = {
        executionKey,
        generationId: event.repairGenerationId,
        converted: event.repairTreatmentOutcome === 'converted',
      };
    }
  } else {
    attribution.attributedEvents++;
    const repeatedOrdinal = unit.rawOrdinals.has(event.repairAttemptOrdinal!);
    unit.rawOrdinals.add(event.repairAttemptOrdinal!);
    const fingerprint = JSON.stringify([
      event.repairHandoffId,
      event.backend,
      event.outcome,
      event.proposalCreated,
      event.proposalId ?? null,
    ]);
    const prior = unit.rawAttempts.get(executionKey);
    if (repeatedOrdinal || prior !== undefined) attribution.replayedEvents++;
    if (prior !== undefined) {
      if (prior !== fingerprint) attribution.unattributedEvents++;
    } else {
      unit.rawAttempts.set(executionKey, fingerprint);
    }
  }
  units.set(unitId, unit);
  attribution.units.set(treatment, units);
}

function sampleGatedTreatmentConversions(
  attribution: MutableRepairTreatmentAttribution,
): RepairTreatmentConversionSummary[] | undefined {
  if (attribution.unattributedEvents > 0 || attribution.replayedEvents > 0) return undefined;
  if (REPAIR_TREATMENTS.some(
    (treatment) => (attribution.units.get(treatment)?.size ?? 0) < MIN_REPAIR_TREATMENT_ATTEMPTS,
  )) return undefined;
  const allUnits = [...attribution.units.values()].flatMap((units) => [...units.values()]);
  if (allUnits.some((unit) =>
    unit.witnessEvents !== 1 ||
    unit.witness === undefined ||
    !unit.rawAttempts.has(unit.witness.executionKey)
  )) return undefined;
  const conversions = REPAIR_TREATMENTS
    .map((treatment) => [treatment, attribution.units.get(treatment)!] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repairTreatment, units]) => {
      const attempts = units.size;
      const proposalsCreated = [...units.values()].filter((unit) => unit.witness?.converted === true).length;
      return {
        repairTreatment,
        attempts,
        proposalsCreated,
        noProposal: attempts - proposalsCreated,
        proposalRate: proposalsCreated / attempts,
      };
    });
  return conversions.length > 0 ? conversions : undefined;
}

function treatmentAttributionSummary(
  attribution: MutableRepairTreatmentAttribution,
): RepairTreatmentAttributionSummary | undefined {
  if (attribution.eligibleEvents === 0) return undefined;
  const distinctUnits = [...attribution.units.values()].reduce((sum, units) => sum + units.size, 0);
  const arms = REPAIR_TREATMENTS
    .map((repairTreatment): RepairTreatmentAttributionArmSummary => {
      const units = [...(attribution.units.get(repairTreatment)?.values() ?? [])];
      const attributedUnits = units.filter((unit) => unit.rawAttempts.size > 0).length;
      const terminalUnits = units.filter((unit) =>
        unit.witnessEvents === 1 &&
        unit.witness !== undefined &&
        unit.rawAttempts.has(unit.witness.executionKey)
      ).length;
      return {
        repairTreatment,
        attributedUnits,
        terminalUnits,
        remaining: Math.max(0, MIN_REPAIR_TREATMENT_ATTEMPTS - terminalUnits),
      };
    })
    .sort((left, right) => left.repairTreatment.localeCompare(right.repairTreatment));
  const blockers: RepairTreatmentAttributionBlocker[] = [];
  if (arms.some((arm) => arm.attributedUnits > arm.terminalUnits)) blockers.push('in-flight');
  const hasUnmatchedTerminal = [...attribution.units.values()].some((units) =>
    [...units.values()].some((unit) =>
      unit.witnessEvents > 0 && (
        unit.witnessEvents !== 1 ||
        unit.witness === undefined ||
        !unit.rawAttempts.has(unit.witness.executionKey)
      )
    )
  );
  if (hasUnmatchedTerminal) blockers.push('unmatched-terminal');
  if (attribution.unattributedEvents > 0) blockers.push('unattributed');
  if (attribution.replayedEvents > 0) blockers.push('replayed');
  const integrityWithheld = blockers.includes('unmatched-terminal') ||
    blockers.includes('unattributed') ||
    blockers.includes('replayed');
  const ready = arms.every((arm) => arm.remaining === 0) && !blockers.includes('in-flight');
  return {
    eligibleEvents: attribution.eligibleEvents,
    attributedEvents: attribution.attributedEvents,
    unattributedEvents: attribution.unattributedEvents,
    distinctUnits,
    replayedEvents: attribution.replayedEvents,
    minimumTerminalUnitsPerArm: MIN_REPAIR_TREATMENT_ATTEMPTS,
    arms,
    gate: integrityWithheld ? 'withheld' : ready ? 'ready' : 'collecting',
    blockers,
  };
}

function touchBucket(
  buckets: Map<string, MutableYieldBucket>,
  key: string,
  fields: Omit<Partial<MutableYieldBucket>, 'key' | 'attempts' | 'proposalsCreated' | 'spentUsd' | 'outcomes' | 'reasons'>,
): MutableYieldBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      key,
      ...fields,
      attempts: 0,
      proposalsCreated: 0,
      diagnosticAttempts: 0,
      diagnosticProposalsCreated: 0,
      diagnosticNoProposal: 0,
      spentUsd: 0,
      outcomes: emptyOutcomeCounts(),
      actionCounts: {},
      attemptShape: emptyProductionAttemptShape(),
      generatedRepairAttempts: emptyGeneratedRepairAttemptSummary(),
      repairTreatments: emptyRepairTreatmentAttribution(),
      reasons: new Map(),
      diagnosticReasons: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function addToBucket(bucket: MutableYieldBucket, event: DispatchProductionEvent): void {
  incrementOutcome(bucket.outcomes, outcomeForAccounting(event));
  addRunActionCounts(bucket.actionCounts, event.runEventSummary?.actionCounts);
  const classification = classifyProductionAttemptForLearningWithLabel({
    outcome: event.outcome,
    proposalCreated: event.proposalCreated,
    actionCounts: event.runEventSummary?.actionCounts,
    reason: event.reason ?? event.routeReason,
    itemId: event.itemId,
    title: event.title,
    source: event.source,
  }, diagnosticDispatchProductionLearningLabel(event));
  const cancelled = isCancelledDispatchProductionEvent(event);
  if (cancelled) return;
  bucket.attempts++;
  if (event.proposalCreated) bucket.proposalsCreated++;
  bucket.spentUsd += Number.isFinite(event.spentUsd) ? event.spentUsd : 0;
  if (!cancelled && classification.diagnosticAttempt) bucket.diagnosticAttempts++;
  if (!cancelled && classification.kind === 'proposal-created') bucket.diagnosticProposalsCreated++;
  if (!cancelled && classification.diagnosticNoProposal) bucket.diagnosticNoProposal++;
  addProductionAttemptShape(bucket.attemptShape, classification.attemptShape);
  addGeneratedRepairAttempt(
    bucket.generatedRepairAttempts,
    generatedRepairAttemptKindFromSignals({
      itemId: event.itemId,
      title: event.title,
      source: event.source,
    }),
    event.proposalCreated,
    cancelled,
  );
  addRepairTreatmentAttempt(bucket.repairTreatments, event);
  bucket.reasons.set(event.outcome, (bucket.reasons.get(event.outcome) ?? 0) + 1);
  addDiagnosticReason(bucket.diagnosticReasons, dispatchReasonCode(event, classification), classification);
}

function finalizeBucket(bucket: MutableYieldBucket): DispatchProductionYieldBucket {
  const proposalsCreated = bucket.proposalsCreated;
  const attempts = bucket.attempts;
  const treatmentConversions = sampleGatedTreatmentConversions(bucket.repairTreatments);
  const treatmentAttribution = treatmentAttributionSummary(bucket.repairTreatments);
  if (treatmentAttribution) bucket.generatedRepairAttempts.treatmentAttribution = treatmentAttribution;
  if (treatmentConversions) bucket.generatedRepairAttempts.treatmentConversions = treatmentConversions;
  return {
    key: bucket.key,
    ...(bucket.backend !== undefined ? { backend: bucket.backend } : {}),
    ...(bucket.source !== undefined ? { source: bucket.source } : {}),
    ...(bucket.repo !== undefined ? { repo: bucket.repo } : {}),
    ...(bucket.model !== undefined ? { model: bucket.model } : {}),
    attempts,
    proposalsCreated,
    noProposal: Math.max(0, attempts - proposalsCreated),
    ...(attempts > 0 ? { proposalRate: proposalsCreated / attempts } : {}),
    diagnosticAttempts: bucket.diagnosticAttempts,
    diagnosticNoProposal: bucket.diagnosticNoProposal,
    ...(bucket.diagnosticAttempts > 0
      ? { diagnosticProposalRate: bucket.diagnosticProposalsCreated / bucket.diagnosticAttempts }
      : {}),
    spentUsd: bucket.spentUsd,
    outcomes: bucket.outcomes,
    ...(hasRunActionCounts(bucket.actionCounts) ? { actionCounts: bucket.actionCounts } : {}),
    ...(hasProductionAttemptShape(bucket.attemptShape) ? { attemptShape: bucket.attemptShape } : {}),
    ...(hasGeneratedRepairAttemptSummary(bucket.generatedRepairAttempts)
      ? { generatedRepairAttempts: bucket.generatedRepairAttempts }
      : {}),
    topReasons: sortedReasons(bucket.reasons, 5),
    diagnosticTopReasons: sortedReasons(bucket.diagnosticReasons, 5),
  };
}

function sortedBuckets(buckets: Map<string, MutableYieldBucket>, limit: number): DispatchProductionYieldBucket[] {
  return [...buckets.values()]
    .map(finalizeBucket)
    .sort(
      (a, b) =>
        Number((b.diagnosticAttempts ?? 0) > 0) - Number((a.diagnosticAttempts ?? 0) > 0) ||
        (b.diagnosticNoProposal ?? 0) - (a.diagnosticNoProposal ?? 0) ||
        (a.diagnosticProposalRate ?? 0) - (b.diagnosticProposalRate ?? 0) ||
        (b.diagnosticAttempts ?? 0) - (a.diagnosticAttempts ?? 0) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}

function summarizeGeneratedRepairBackendTransitions(
  events: DispatchProductionEvent[],
  limit: number,
): GeneratedRepairBackendTransitionSummary | undefined {
  const attempts = new Map<string, DispatchProductionEvent>();
  const conflicts = new Set<string>();
  let lineageEvents = 0;
  let transitionEvents = 0;
  let duplicateEvents = 0;
  let invalidLineageEvents = 0;

  for (const event of events) {
    const hasAnyLineage = event.repairLineageInvalid === true ||
      event.repairHandoffId !== undefined ||
      event.repairGenerationId !== undefined ||
      event.repairAttemptOrdinal !== undefined ||
      event.repairPreviousBackend !== undefined;
    if (!hasAnyLineage) continue;

    const complete = event.repairLineageInvalid !== true &&
      typeof event.repairHandoffId === 'string' && SHA256_RE.test(event.repairHandoffId) &&
      typeof event.repairGenerationId === 'string' && SHA256_RE.test(event.repairGenerationId) &&
      repairGenerationIdFromHandoffId(event.repairHandoffId) === event.repairGenerationId &&
      (event.repairAttemptOrdinal === 1 || event.repairAttemptOrdinal === 2) &&
      (event.repairAttemptOrdinal === 1
        ? event.repairPreviousBackend === undefined
        : ENGINE_IDS.has(event.repairPreviousBackend as EngineId) && event.backend !== event.repairPreviousBackend);
    if (!complete || !ENGINE_IDS.has(event.backend as EngineId)) {
      invalidLineageEvents++;
      continue;
    }

    lineageEvents++;
    if (event.repairAttemptOrdinal !== 2 || event.repairPreviousBackend === undefined) continue;
    transitionEvents++;
    const executionId = event.runId ?? event.trajectoryId;
    if (!executionId) {
      invalidLineageEvents++;
      continue;
    }
    const key = `${event.repairGenerationId}:2:${executionId}`;
    const previous = attempts.get(key);
    if (!previous) {
      attempts.set(key, event);
      continue;
    }
    const same = previous.repairHandoffId === event.repairHandoffId &&
      previous.repairPreviousBackend === event.repairPreviousBackend &&
      previous.backend === event.backend &&
      outcomeForAccounting(previous) === outcomeForAccounting(event) &&
      previous.proposalCreated === event.proposalCreated;
    if (same) duplicateEvents++;
    else conflicts.add(key);
  }

  if (lineageEvents === 0 && invalidLineageEvents === 0) return undefined;

  const buckets = new Map<string, GeneratedRepairBackendTransitionBucket>();
  for (const [key, event] of attempts) {
    if (conflicts.has(key) || event.backend === null || event.repairPreviousBackend === undefined) continue;
    const bucketKey = `${event.repairPreviousBackend}:${event.backend}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        previousBackend: event.repairPreviousBackend,
        retryBackend: event.backend,
        attempts: 0,
        proposalsCreated: 0,
        noProposal: 0,
        outcomes: emptyOutcomeCounts(),
      };
      buckets.set(bucketKey, bucket);
    }
    incrementOutcome(bucket.outcomes, outcomeForAccounting(event));
    if (isCancelledDispatchProductionEvent(event)) continue;
    bucket.attempts++;
    if (event.proposalCreated) bucket.proposalsCreated++;
    else bucket.noProposal++;
    bucket.proposalRate = bucket.proposalsCreated / bucket.attempts;
  }

  const aggregateAttempts = [...buckets.values()]
    .reduce((total, bucket) => total + bucket.attempts, 0);
  const byTransition = [...buckets.values()]
    .sort((a, b) => b.attempts - a.attempts ||
      a.previousBackend.localeCompare(b.previousBackend) ||
      a.retryBackend.localeCompare(b.retryBackend))
    .slice(0, limit);
  return {
    sourceState: conflicts.size > 0 || invalidLineageEvents > 0 ? 'degraded' : 'healthy',
    lineageEvents,
    transitionEvents,
    attempts: aggregateAttempts,
    duplicateEvents,
    conflictingAttempts: conflicts.size,
    invalidLineageEvents,
    byTransition,
  };
}

export function summarizeDispatchProductionYield(
  events: DispatchProductionEvent[],
  opts?: {
    windowHours?: number;
    limitPerDimension?: number;
  },
): DispatchProductionYieldSummary | undefined {
  const limit = opts?.limitPerDimension !== undefined && opts.limitPerDimension > 0
    ? Math.floor(opts.limitPerDimension)
    : 8;
  if (events.length === 0) return undefined;

  const lifecycleEvents = events.filter((event) =>
    event.basis === 'repair-lifecycle-candidate' || event.basis === 'repair-lifecycle-outcome'
  );
  const physicalAttemptEvents = events.filter((event) =>
    event.basis !== 'repair-lifecycle-candidate' && event.basis !== 'repair-lifecycle-outcome'
  );
  const canonical = canonicalDispatchProductionAttempts(physicalAttemptEvents);
  if (canonical.invalidAttemptIdentities > 0 || canonical.conflictingAttemptIdentities > 0) {
    return undefined;
  }
  const accountingEvents = [...lifecycleEvents, ...canonical.events];

  const byBackend = new Map<string, MutableYieldBucket>();
  const bySource = new Map<string, MutableYieldBucket>();
  const byRepo = new Map<string, MutableYieldBucket>();
  const byBackendModel = new Map<string, MutableYieldBucket>();
  const byBackendSource = new Map<string, MutableYieldBucket>();
  const topReasons = new Map<string, number>();
  const overall = emptyOutcomeCounts();
  const actionCounts: RunActionCounts = {};
  const attemptShape = emptyProductionAttemptShape();
  const generatedRepairAttempts = emptyGeneratedRepairAttemptSummary();
  const repairTreatments = emptyRepairTreatmentAttribution();
  let proposalsCreated = 0;
  let diagnosticAttempts = 0;
  let diagnosticProposalsCreated = 0;
  let diagnosticNoProposal = 0;
  let spentUsd = 0;
  let total = 0;
  let cancelledEvents = 0;
  const diagnosticTopReasons = new Map<string, number>();

  for (const event of accountingEvents) {
    if (event.basis === 'repair-lifecycle-candidate') continue;
    if (event.basis === 'repair-lifecycle-outcome') {
      addRepairTreatmentAttempt(repairTreatments, event);
      addRepairTreatmentAttempt(
        touchBucket(byBackend, event.backend ?? 'unknown', { backend: event.backend }).repairTreatments,
        event,
      );
      addRepairTreatmentAttempt(touchBucket(bySource, event.source, { source: event.source }).repairTreatments, event);
      addRepairTreatmentAttempt(touchBucket(byRepo, event.repo, { repo: event.repo }).repairTreatments, event);
      addRepairTreatmentAttempt(touchBucket(
        byBackendModel,
        `${event.backend ?? 'unknown'}:${event.model ?? 'default'}`,
        { backend: event.backend, model: event.model ?? null },
      ).repairTreatments, event);
      addRepairTreatmentAttempt(touchBucket(
        byBackendSource,
        `${event.backend ?? 'unknown'}:${event.source}`,
        { backend: event.backend, source: event.source },
      ).repairTreatments, event);
      continue;
    }
    incrementOutcome(overall, outcomeForAccounting(event));
    addRunActionCounts(actionCounts, event.runEventSummary?.actionCounts);
    const classification = classifyProductionAttemptForLearningWithLabel({
      outcome: event.outcome,
      proposalCreated: event.proposalCreated,
      actionCounts: event.runEventSummary?.actionCounts,
      reason: event.reason ?? event.routeReason,
      itemId: event.itemId,
      title: event.title,
      source: event.source,
    }, diagnosticDispatchProductionLearningLabel(event));
    const backendKey = event.backend ?? 'unknown';
    addToBucket(touchBucket(byBackend, backendKey, { backend: event.backend }), event);
    addToBucket(touchBucket(bySource, event.source, { source: event.source }), event);
    addToBucket(touchBucket(byRepo, event.repo, { repo: event.repo }), event);
    addToBucket(touchBucket(
      byBackendModel,
      `${event.backend ?? 'unknown'}:${event.model ?? 'default'}`,
      { backend: event.backend, model: event.model ?? null },
    ), event);
    addToBucket(touchBucket(
      byBackendSource,
      `${event.backend ?? 'unknown'}:${event.source}`,
      { backend: event.backend, source: event.source },
    ), event);
    const cancelled = isCancelledDispatchProductionEvent(event);
    if (cancelled) {
      cancelledEvents++;
      continue;
    }
    total++;
    if (event.proposalCreated) proposalsCreated++;
    spentUsd += Number.isFinite(event.spentUsd) ? event.spentUsd : 0;
    if (!cancelled && classification.diagnosticAttempt) diagnosticAttempts++;
    if (!cancelled && classification.kind === 'proposal-created') diagnosticProposalsCreated++;
    if (!cancelled && classification.diagnosticNoProposal) diagnosticNoProposal++;
    addProductionAttemptShape(attemptShape, classification.attemptShape);
    addGeneratedRepairAttempt(
      generatedRepairAttempts,
      generatedRepairAttemptKindFromSignals({
        itemId: event.itemId,
        title: event.title,
        source: event.source,
      }),
      event.proposalCreated,
      cancelled,
    );
    addRepairTreatmentAttempt(repairTreatments, event);
    topReasons.set(event.outcome, (topReasons.get(event.outcome) ?? 0) + 1);
    addDiagnosticReason(diagnosticTopReasons, dispatchReasonCode(event, classification), classification);

  }

  const treatmentConversions = sampleGatedTreatmentConversions(repairTreatments);
  const treatmentAttribution = treatmentAttributionSummary(repairTreatments);
  if (treatmentAttribution) generatedRepairAttempts.treatmentAttribution = treatmentAttribution;
  if (treatmentConversions) generatedRepairAttempts.treatmentConversions = treatmentConversions;
  const generatedRepairBackendTransitions = summarizeGeneratedRepairBackendTransitions(
    canonical.events,
    limit,
  );
  return {
    windowHours: opts?.windowHours ?? 24,
    attempts: total,
    events: physicalAttemptEvents.length,
    proposalsCreated,
    noProposal: Math.max(0, total - proposalsCreated),
    ...(total > 0 ? { proposalRate: proposalsCreated / total } : {}),
    preEnvelopeEvents: canonical.preEnvelopeEvents,
    duplicateEvents: canonical.duplicateEvents,
    invalidAttemptIdentities: canonical.invalidAttemptIdentities,
    conflictingAttemptIdentities: canonical.conflictingAttemptIdentities,
    cancelledEvents,
    diagnosticAttempts,
    diagnosticNoProposal,
    ...(diagnosticAttempts > 0
      ? { diagnosticProposalRate: diagnosticProposalsCreated / diagnosticAttempts }
      : {}),
    spentUsd,
    outcomes: overall,
    ...(hasRunActionCounts(actionCounts) ? { actionCounts } : {}),
    ...(hasProductionAttemptShape(attemptShape) ? { attemptShape } : {}),
    ...(hasGeneratedRepairAttemptSummary(generatedRepairAttempts) ? { generatedRepairAttempts } : {}),
    ...(generatedRepairBackendTransitions ? { generatedRepairBackendTransitions } : {}),
    topReasons: sortedReasons(topReasons, limit),
    diagnosticTopReasons: sortedReasons(diagnosticTopReasons, limit),
    byBackend: sortedBuckets(byBackend, limit),
    bySource: sortedBuckets(bySource, limit),
    byRepo: sortedBuckets(byRepo, limit),
    byBackendModel: sortedBuckets(byBackendModel, limit),
    byBackendSource: sortedBuckets(byBackendSource, limit),
  };
}

export function readDispatchProductionYieldDetailed(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
  maxBytes?: number;
  maxRows?: number;
}): DispatchProductionYieldReadResult {
  const windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;
  const maxFiles = Math.max(1, Math.ceil(windowMs / DAY_MS) + 1);
  const read = readDispatchProductionEventsDetailed({
    sinceMs,
    limit: opts?.limit ?? 1000,
    maxFiles,
    maxBytes: opts?.maxBytes,
    maxRows: opts?.maxRows,
  });
  const sourceComplete = read.sourceState === 'healthy' && read.complete;
  const physicalAttemptEvents = read.events.filter((event) =>
    event.basis !== 'repair-lifecycle-candidate' && event.basis !== 'repair-lifecycle-outcome'
  );
  const canonical = sourceComplete
    ? canonicalDispatchProductionAttempts(physicalAttemptEvents)
    : undefined;
  const identityDegraded = canonical !== undefined &&
    (canonical.invalidAttemptIdentities > 0 || canonical.conflictingAttemptIdentities > 0);
  const summary = sourceComplete && !identityDegraded
    ? summarizeDispatchProductionYield(read.events, {
        windowHours: windowMs / (60 * 60 * 1000),
        limitPerDimension: opts?.limitPerDimension,
      })
    : undefined;
  const { events: _events, invalidReasonCounts: _invalidReasonCounts, ...baseSourceQuality } = read;
  const sourceQuality: DispatchProductionSourceQuality = identityDegraded
    ? {
        ...baseSourceQuality,
        sourceState: 'degraded',
        complete: false,
        stopReasons: [
          ...baseSourceQuality.stopReasons,
          ...(canonical!.invalidAttemptIdentities > 0
            ? ['attempt-identity-unavailable' as const]
            : []),
          ...(canonical!.conflictingAttemptIdentities > 0
            ? ['attempt-identity-conflict' as const]
            : []),
        ],
      }
    : baseSourceQuality;
  return {
    ...(summary ? { summary } : {}),
    sourceQuality,
    events: read.events,
  };
}

export function readDispatchProductionYield(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
  maxBytes?: number;
  maxRows?: number;
}): DispatchProductionYieldSummary | undefined {
  return readDispatchProductionYieldDetailed(opts).summary;
}
