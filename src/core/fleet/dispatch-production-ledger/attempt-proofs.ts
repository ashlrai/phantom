/** Stored event validation and bounded attempt proof reads. */

import type {
  DispatchProductionEvent,
  DispatchProductionAttemptProof,
  DispatchProductionFailureAttemptProof,
  DispatchProductionAttemptProofDegradedReason,
  DispatchProductionBasis,
  DispatchProductionLabelOrigin,
  DispatchProductionAttemptProofTarget,
  DispatchProductionAttemptWitnessResolution,
} from './types.js';
import { scrubSecrets } from '../../util/scrub.js';
import { isSafeExecutionIdentity } from '../attempt-identity.js';
import {
  isDispatchProductionEvent,
  dispatchProductionSuppliedEnvelopeSemanticsAgree,
  sanitizeDispatchProductionEvent,
  canonicalDispatchRepoIdentity,
} from './events.js';
import {
  MAX_ATTEMPT_FUTURE_SKEW_MS,
  WORK_SOURCES,
  DISPATCH_PRODUCTION_OUTCOMES,
  DISPATCH_PRODUCTION_BASES,
  ENGINE_IDS,
  ENGINE_TIERS,
  ATTEMPT_RECEIPT_FAILURE_OUTCOMES,
  SHA256_RE,
  DISPATCH_PRODUCTION_EVENT_KEYS,
  MAX_DIRECTORY_ENTRIES,
  DATE_LEDGER_FILE_RE,
  MAX_READ_ROW_BYTES,
  HARD_READ_MAX_FILES,
  HARD_READ_MAX_BYTES,
  HARD_READ_MAX_ROWS,
  ATTEMPT_BLOCKED_MEMBERSHIP_BYTES,
  ATTEMPT_RECEIPT_VALIDATION,
  ATTEMPT_RECEIPT_FILE_RE,
} from './constants.js';
import type {
  WorkItem,
  DaemonDispatchProductionOutcome,
  EngineId,
  EngineTier,
  RepairTreatment,
} from '../../types.js';
import {
  sanitizeProductionAttemptLearningLabel,
  type ProductionAttemptLearningLabel,
} from '../../learning/attempt-shape.js';
import { basename, isAbsolute, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  REPAIR_TREATMENTS,
  repairTreatmentForUnitId,
  repairGenerationIdFromHandoffId,
  generatedRepairLifecycleAttemptHash,
} from '../generated-repair-identity.js';
import {
  routeSnapshot as normalizeRouteSnapshot,
  runEventSummary as normalizeRunEventSummary,
} from '../../learning/causal.js';
import { type BigIntStats, lstatSync, realpathSync, opendirSync, existsSync } from 'node:fs';
import { assurePrivateStoragePath } from '../../util/private-storage.js';
import {
  type StableFileReadFailureReason,
  openStableDirectoryGuard,
  readStableRegularFile,
} from '../../util/stable-file-read.js';
import {
  dispatchProductionDir,
  attemptProofReceiptDir,
  inspectExactReceiptAuthorityDirectory,
  attemptProofReceiptName,
  inspectExactReceiptAuthorityFile,
} from './storage.js';
import {
  type AttemptGenerationMembership,
  setAttemptGenerationMembershipBits,
  emptyAttemptGenerationMembership,
  type AttemptReceiptProtocolActivation,
  readAttemptReceiptRetentionState,
  readAttemptReceiptProtocolActivation,
  membershipSetSaturated,
  attemptGenerationMembershipHas,
} from './attempt-retention.js';
import { attemptReceiptIntentPath, attemptReceiptEnvelope } from './write.js';

export interface ParsedDispatchProductionAttemptAuthority {
  event: DispatchProductionEvent;
  proof: DispatchProductionAttemptProof;
}

interface ParsedDispatchProductionFailureAttemptAuthority {
  event: DispatchProductionEvent;
  proof: DispatchProductionFailureAttemptProof;
}

interface ParsedDispatchProductionPartitionMatch {
  row: ParsedDispatchProductionAttemptAuthority | null;
  event: DispatchProductionEvent;
  eventDigest: string;
  conflict: boolean;
}

export interface ParsedDispatchProductionSequenceMatch {
  row: ParsedDispatchProductionAttemptAuthority | null;
  eventDigest: string;
  ordinal: 1 | 2;
  ts: string;
}

type AttemptReceiptCachedPartition =
  | { ok: true; sequenceMatches: Map<string, ParsedDispatchProductionSequenceMatch[]> }
  | { ok: false; reason: DispatchProductionAttemptProofDegradedReason };

export interface AttemptReceiptBatchReadContext {
  wantedGenerationIds: ReadonlySet<string>;
  partitionCache: Map<string, AttemptReceiptCachedPartition>;
  partitionDates?: { ok: true; dates: string[] } |
    { ok: false; reason: DispatchProductionAttemptProofDegradedReason };
  filesRead: number;
  bytesRead: number;
  rowsRead: number;
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function canonicalUtcTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : null;
}

function boundedStoredText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim() === value && scrubSecrets(value) === value &&
    ![...value].some((char) => char.charCodeAt(0) < 32);
}

function validRunTrajectory(value: unknown): value is string {
  return boundedStoredText(value, 240) && value.startsWith('run:') &&
    isSafeExecutionIdentity(value.slice('run:'.length));
}

export function canonicalStoredDispatchProductionEvent(
  value: unknown,
  line: string,
  partitionDate: string,
): value is DispatchProductionEvent {
  if (!isPlainRecord(value) || JSON.stringify(value) !== line || !isDispatchProductionEvent(value)) return false;
  if (!dispatchProductionSuppliedEnvelopeSemanticsAgree(value)) return false;
  try {
    const canonical = sanitizeDispatchProductionEvent(value, { materializeLearningLabel: true });
    if (JSON.stringify(canonical) !== line &&
      !legacyV1LearningLabelMatchesCanonicalEvent(value, canonical, line)) return false;
  } catch {
    return false;
  }
  const ts = canonicalUtcTimestamp(value['ts']);
  if (ts === null || ts.slice(0, 10) !== partitionDate) return false;
  if (Date.parse(ts) > Date.now() + MAX_ATTEMPT_FUTURE_SKEW_MS) return false;
  if (!WORK_SOURCES.has(value['source'] as WorkItem['source'])) return false;
  if (!DISPATCH_PRODUCTION_OUTCOMES.has(value['outcome'] as DaemonDispatchProductionOutcome)) return false;
  if (!DISPATCH_PRODUCTION_BASES.has(value['basis'] as DispatchProductionBasis)) return false;
  if (value['backend'] !== null && !ENGINE_IDS.has(value['backend'] as EngineId)) return false;
  if (value['tier'] !== null && !ENGINE_TIERS.has(value['tier'] as EngineTier)) return false;
  if (hasOwn(value, 'model') && value['model'] !== null && !boundedStoredText(value['model'], 160)) return false;
  return true;
}

function legacyV1LearningLabelMatchesCanonicalEvent(
  stored: Record<string, unknown>,
  canonical: DispatchProductionEvent,
  line: string,
): boolean {
  const label = stored['learningLabel'];
  if (!isPlainRecord(label) ||
    !hasOnlyKeys(label, new Set([
      'schemaVersion', 'classifierVersion', 'authoritative', 'learningKind',
      'policySuppressed', 'diagnosticNoProposal', 'diagnosticAttempt', 'attemptShape',
    ])) ||
    label['classifierVersion'] !== 'attempt-shape-v1' ||
    !isPlainRecord(label['attemptShape']) ||
    !hasOnlyKeys(label['attemptShape'], new Set([
      'backendNoDiff', 'captureOrGateBlocked', 'repairAttempts', 'policyDisabled',
    ]))) return false;
  const normalized = sanitizeProductionAttemptLearningLabel(label);
  const recomputed = sanitizeDispatchProductionEvent({
    ...stored,
    learningLabel: undefined,
  } as unknown as DispatchProductionEvent, { materializeLearningLabel: true });
  const recomputedLabel = recomputed.learningLabel;
  if (normalized === undefined || recomputedLabel === undefined ||
    (
      JSON.stringify(normalized) !== JSON.stringify(recomputedLabel) &&
      !legacyV1GeneratedRepairLabelMatchesCurrent(
        recomputed,
        label,
        normalized,
        recomputedLabel,
        stored as unknown as DispatchProductionEvent,
      )
    )) return false;
  return JSON.stringify({ ...canonical, learningLabel: label }) === line;
}

export function storedLearningLabelOrigin(value: unknown): DispatchProductionLabelOrigin {
  if (value === undefined) return 'derived-on-read';
  if (!isPlainRecord(value)) throw new Error('invalid stored learning label');
  const normalized = sanitizeProductionAttemptLearningLabel(value);
  if (normalized === undefined) throw new Error('invalid stored learning label');
  if (value['classifierVersion'] === 'attempt-shape-v2' &&
    JSON.stringify(value) === JSON.stringify(normalized)) return 'stored-current';
  if (
    value['classifierVersion'] === 'attempt-shape-v1' &&
    hasOnlyKeys(value, new Set([
      'schemaVersion', 'classifierVersion', 'authoritative', 'learningKind',
      'policySuppressed', 'diagnosticNoProposal', 'diagnosticAttempt', 'attemptShape',
    ])) &&
    isPlainRecord(value['attemptShape']) &&
    hasOnlyKeys(value['attemptShape'], new Set([
      'backendNoDiff', 'captureOrGateBlocked', 'repairAttempts', 'policyDisabled',
    ]))
  ) return 'stored-legacy';
  throw new Error('invalid stored learning label');
}

function legacyV1GeneratedRepairLabelMatchesCurrent(
  event: DispatchProductionEvent,
  storedLabel: unknown,
  normalized: ProductionAttemptLearningLabel,
  canonical: ProductionAttemptLearningLabel,
  rawEvent: DispatchProductionEvent = event,
): boolean {
  if (
    !isPlainRecord(storedLabel) ||
    storedLabel['classifierVersion'] !== 'attempt-shape-v1' ||
    !legacyGeneratedRepairIdentityMatchesFactory(rawEvent) ||
    normalized.attemptShape.repairAttempts !== 0 ||
    canonical.attemptShape.repairAttempts !== 1
  ) return false;
  return JSON.stringify({
    ...normalized,
    attemptShape: { ...normalized.attemptShape, repairAttempts: 1 },
  }) === JSON.stringify(canonical);
}

function legacyGeneratedRepairIdentityMatchesFactory(event: DispatchProductionEvent): boolean {
  if (event.source !== 'self') return false;
  const repoName = basename(event.repo);
  const recipes = [
    {
      titlePrefix: `Repair dispatch capture failure for ${repoName} item `,
      itemPrefix: `${repoName}:proposal-repair-capture:`,
      domain: 'dispatch-capture-gate-repair',
    },
    {
      titlePrefix: `Reslice no-diff dispatch for ${repoName} item `,
      itemPrefix: `${repoName}:proposal-repair-nodiff:`,
      domain: 'dispatch-no-diff-reslice',
    },
  ] as const;
  for (const recipe of recipes) {
    if (!event.title.startsWith(recipe.titlePrefix)) continue;
    const parentItemId = event.title.slice(recipe.titlePrefix.length);
    if (!boundedStoredText(parentItemId, 120)) return false;
    const hash = createHash('sha1')
      .update(`${event.repo}\0${parentItemId}\0${recipe.domain}`)
      .digest('hex')
      .slice(0, 12);
    return event.itemId === `${recipe.itemPrefix}${hash}`;
  }
  return false;
}

export function withLearningLabelOrigin(
  event: DispatchProductionEvent,
  storedLabel: unknown,
  rawEvent: DispatchProductionEvent = event,
): DispatchProductionEvent {
  const labelOrigin = storedLearningLabelOrigin(storedLabel);
  let learningLabel = event.learningLabel;
  if (labelOrigin === 'stored-legacy') {
    const normalized = sanitizeProductionAttemptLearningLabel(storedLabel);
    const canonicalLabel = sanitizeDispatchProductionEvent({
      ...rawEvent,
      learningLabel: undefined,
    }, {
      materializeLearningLabel: true,
    }).learningLabel;
    if (
      normalized === undefined ||
      canonicalLabel === undefined ||
      (
        JSON.stringify(normalized) !== JSON.stringify(canonicalLabel) &&
        !legacyV1GeneratedRepairLabelMatchesCurrent(
          event,
          storedLabel,
          normalized,
          canonicalLabel,
          rawEvent,
        )
      )
    ) throw new Error('stored learning label does not match canonical attempt');
    learningLabel = canonicalLabel;
  } else if (labelOrigin === 'stored-current') {
    const normalized = sanitizeProductionAttemptLearningLabel(storedLabel);
    if (normalized === undefined) throw new Error('invalid stored learning label');
    learningLabel = normalized;
  }
  return {
    ...event,
    ...(learningLabel ? { learningLabel } : {}),
    labelOrigin,
  };
}

export function currentAuthoritativeDispatchProductionLearningLabel(
  _event: DispatchProductionEvent,
): ProductionAttemptLearningLabel | undefined {
  // Dispatch rows and their local attempt receipts are owner-writable and
  // explicitly non-cryptographic. They remain diagnostic until a writer-
  // authenticated receipt verifier is available for this exact record type.
  return undefined;
}

export function diagnosticDispatchProductionLearningLabel(
  event: DispatchProductionEvent,
): ProductionAttemptLearningLabel | undefined {
  return sanitizeProductionAttemptLearningLabel(event.learningLabel);
}

export function storedDispatchProductionIdentities(
  value: unknown,
  line: string,
  partitionDate: string,
): string[] | null {
  if (!isPlainRecord(value) || JSON.stringify(value) !== line) return null;
  const ts = canonicalUtcTimestamp(value['ts']);
  const attemptId = value['trajectoryId'] ?? value['runId'];
  const rawRepo = value['repo'];
  if (ts === null || ts.slice(0, 10) !== partitionDate ||
    !boundedStoredText(value['itemId'], 240) ||
    !DISPATCH_PRODUCTION_OUTCOMES.has(value['outcome'] as DaemonDispatchProductionOutcome) ||
    !boundedStoredText(attemptId, 240) || !boundedStoredText(rawRepo, 500) ||
    !isAbsolute(rawRepo)) return null;
  const repos = [rawRepo];
  const canonicalRepo = canonicalDispatchRepoIdentity(rawRepo);
  if (canonicalRepo !== null && canonicalRepo !== rawRepo) repos.push(canonicalRepo);
  return repos.map((repo) => JSON.stringify([
    ts, value['itemId'], repo, value['outcome'], attemptId,
  ]));
}

function parseDispatchProductionReceiptAuthority(
  event: DispatchProductionEvent,
  line: string,
): ParsedDispatchProductionAttemptAuthority | null {
  const raw = event as unknown as Record<string, unknown>;
  const proposalCreated = event.outcome === 'proposal-created';
  const failedAttempt = ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(event.outcome);
  const emptyAttempt = event.outcome === 'empty-diff';
  const diagnosticAttempt = /:proposal-repair-nodiff:[0-9a-f]{12}$/.test(event.itemId) &&
    SHA256_RE.test(event.repairTreatmentUnitId ?? '') &&
    REPAIR_TREATMENTS.includes(event.repairTreatment as RepairTreatment) &&
    repairTreatmentForUnitId(event.repairTreatmentUnitId!) === event.repairTreatment;
  const genericAttempt = /:proposal-repair(?:-capture)?:[0-9a-f]{12}$/.test(event.itemId) &&
    !hasOwn(raw, 'repairTreatmentUnitId') && !hasOwn(raw, 'repairTreatment') &&
    SHA256_RE.test(event.repairRootId ?? '') &&
    (event.repairDepth === 0 || event.repairDepth === 1);
  if (
    !hasOnlyKeys(raw, DISPATCH_PRODUCTION_EVENT_KEYS) ||
    event.basis !== 'run-proposal-outcome' ||
    (!emptyAttempt && !proposalCreated && !failedAttempt) ||
    event.proposalCreated !== proposalCreated ||
    (proposalCreated
      ? !boundedStoredText(event.proposalId, 160) || !isSafeExecutionIdentity(event.proposalId)
      : hasOwn(raw, 'proposalId')) ||
    hasOwn(raw, 'repairLineageInvalid') ||
    hasOwn(raw, 'repairTreatmentOutcome') ||
    hasOwn(raw, 'repairTreatmentAttemptHash') ||
    !boundedStoredText(event.itemId, 240) ||
    (!diagnosticAttempt && !genericAttempt) ||
    !boundedStoredText(event.title, 160) ||
    !boundedStoredText(event.assignedBy, 80) ||
    !boundedStoredText(event.routeReason, 240) ||
    event.source !== 'self' ||
    !ENGINE_IDS.has(event.backend as EngineId) ||
    event.backend === null || event.backend === 'builtin' ||
    !ENGINE_TIERS.has(event.tier as EngineTier) ||
    event.tier === null ||
    (hasOwn(raw, 'model') && event.model !== null && !boundedStoredText(event.model, 160)) ||
    !isSafeExecutionIdentity(event.runId) ||
    !validRunTrajectory(event.trajectoryId) ||
    (genericAttempt && event.trajectoryId !== `run:${event.runId}`) ||
    !SHA256_RE.test(event.objectiveHash ?? '') ||
    event.learningSource !== 'daemon-dispatch' ||
    event.labelBasis !== 'dispatch-outcome' ||
    !boundedStoredText(event.routerPolicyVersion, 80) ||
    !SHA256_RE.test(event.repairGenerationId ?? '') ||
    (diagnosticAttempt && (!SHA256_RE.test(event.repairHandoffId ?? '') ||
      repairGenerationIdFromHandoffId(event.repairHandoffId!) !== event.repairGenerationId)) ||
    (genericAttempt && hasOwn(raw, 'repairHandoffId') &&
      !SHA256_RE.test(event.repairHandoffId ?? '')) ||
    (event.repairAttemptOrdinal !== 1 && event.repairAttemptOrdinal !== 2) ||
    (diagnosticAttempt && (failedAttempt
      ? !SHA256_RE.test(event.repairRootId ?? '') ||
        (event.repairDepth !== 0 && event.repairDepth !== 1)
      : hasOwn(raw, 'repairRootId') || hasOwn(raw, 'repairDepth'))) ||
    !Number.isFinite(event.spentUsd) || event.spentUsd < 0 ||
    (emptyAttempt && event.diffFiles !== undefined && event.diffFiles !== 0) ||
    (emptyAttempt && event.diffLines !== undefined && event.diffLines !== 0)
  ) return null;

  if (event.repairAttemptOrdinal === 1) {
    if (hasOwn(raw, 'repairPreviousBackend')) return null;
  } else if (
    !ENGINE_IDS.has(event.repairPreviousBackend as EngineId) ||
    event.repairPreviousBackend === 'builtin' ||
    event.repairPreviousBackend === event.backend
  ) return null;

  const route = event.routeSnapshot;
  if (!isPlainRecord(route) ||
    JSON.stringify(normalizeRouteSnapshot(route)) !== JSON.stringify(route) ||
    route['backend'] !== event.backend ||
    route['tier'] !== event.tier ||
    hasOwn(route, 'model') !== hasOwn(raw, 'model') ||
    (hasOwn(route, 'model') && route['model'] !== event.model) ||
    route['assignedBy'] !== event.assignedBy ||
    route['routerPolicyVersion'] !== event.routerPolicyVersion) return null;

  const summary = event.runEventSummary;
  if (!isPlainRecord(summary) ||
    JSON.stringify(normalizeRunEventSummary(summary)) !== JSON.stringify(summary) ||
    summary['runId'] !== event.runId ||
    (failedAttempt
      ? summary['status'] !== 'done' && summary['status'] !== 'failed' && summary['status'] !== 'aborted'
      : summary['status'] !== 'done') ||
    summary['outcome'] !== event.outcome ||
    summary['proposalCreated'] !== proposalCreated ||
    (proposalCreated
      ? summary['proposalId'] !== event.proposalId
      : hasOwn(summary, 'proposalId')) ||
    summary['costUsd'] !== event.spentUsd ||
    (emptyAttempt && hasOwn(summary, 'diffFiles') && summary['diffFiles'] !== 0) ||
    (emptyAttempt && hasOwn(summary, 'diffLines') && summary['diffLines'] !== 0) ||
    (event.diffFiles !== undefined && summary['diffFiles'] !== undefined &&
      summary['diffFiles'] !== event.diffFiles) ||
    (event.diffLines !== undefined && summary['diffLines'] !== undefined &&
      summary['diffLines'] !== event.diffLines)) return null;

  const actionCounts = summary['actionCounts'];
  if (actionCounts !== undefined && (!isPlainRecord(actionCounts) ||
    (emptyAttempt && hasOwn(actionCounts, 'diffFiles') && actionCounts['diffFiles'] !== 0) ||
    (emptyAttempt && hasOwn(actionCounts, 'diffLines') && actionCounts['diffLines'] !== 0) ||
    (hasOwn(actionCounts, 'proposalCreated') &&
      actionCounts['proposalCreated'] !== (proposalCreated ? 1 : 0)) ||
    (event.diffFiles !== undefined && actionCounts['diffFiles'] !== undefined &&
      actionCounts['diffFiles'] !== event.diffFiles) ||
    (summary['diffFiles'] !== undefined && actionCounts['diffFiles'] !== undefined &&
      actionCounts['diffFiles'] !== summary['diffFiles']) ||
    (event.diffLines !== undefined && actionCounts['diffLines'] !== undefined &&
      actionCounts['diffLines'] !== event.diffLines) ||
    (summary['diffLines'] !== undefined && actionCounts['diffLines'] !== undefined &&
      actionCounts['diffLines'] !== summary['diffLines']))) return null;

  return {
    event,
    proof: {
      schemaVersion: 1,
      integrityClass: 'owner-writable-local',
      cryptographicallyTrusted: false,
      rollbackProtected: false,
      eventTs: event.ts,
      eventDigest: createHash('sha256').update(line, 'utf8').digest('hex'),
      attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId),
      backend: event.backend,
      tier: event.tier,
      model: event.model ?? null,
      previousBackend: event.repairAttemptOrdinal === 2
        ? event.repairPreviousBackend as Exclude<EngineId, 'builtin'>
        : null,
      repairHandoffId: event.repairHandoffId!,
      repairGenerationId: event.repairGenerationId!,
      repairTreatmentUnitId: event.repairTreatmentUnitId!,
      repairTreatment: event.repairTreatment!,
      repairAttemptOrdinal: event.repairAttemptOrdinal,
    },
  };
}

export function parseDispatchProductionAttemptAuthority(
  event: DispatchProductionEvent,
  line: string,
): ParsedDispatchProductionAttemptAuthority | null {
  const authority = parseDispatchProductionReceiptAuthority(event, line);
  return authority !== null && !ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(event.outcome)
    ? authority
    : null;
}

export function parseDispatchProductionFailureAttemptAuthority(
  event: DispatchProductionEvent,
  line: string,
): ParsedDispatchProductionFailureAttemptAuthority | null {
  const diagnostic = parseDispatchProductionReceiptAuthority(event, line);
  if (diagnostic !== null && ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(event.outcome)) {
    return diagnostic;
  }

  const raw = event as unknown as Record<string, unknown>;
  if (
    !hasOnlyKeys(raw, DISPATCH_PRODUCTION_EVENT_KEYS) ||
    event.basis !== 'run-proposal-outcome' ||
    !ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(event.outcome) ||
    event.proposalCreated || hasOwn(raw, 'proposalId') ||
    hasOwn(raw, 'repairLineageInvalid') ||
    hasOwn(raw, 'repairTreatmentUnitId') || hasOwn(raw, 'repairTreatment') ||
    hasOwn(raw, 'repairTreatmentOutcome') || hasOwn(raw, 'repairTreatmentAttemptHash') ||
    !boundedStoredText(event.itemId, 240) ||
    !/:proposal-repair(?:-capture)?:[0-9a-f]{12}$/.test(event.itemId) ||
    !boundedStoredText(event.title, 160) ||
    !boundedStoredText(event.assignedBy, 80) ||
    !boundedStoredText(event.routeReason, 240) ||
    event.source !== 'self' ||
    !ENGINE_IDS.has(event.backend as EngineId) ||
    event.backend === null || event.backend === 'builtin' ||
    !ENGINE_TIERS.has(event.tier as EngineTier) || event.tier === null ||
    (hasOwn(raw, 'model') && event.model !== null && !boundedStoredText(event.model, 160)) ||
    !isSafeExecutionIdentity(event.runId) ||
    !validRunTrajectory(event.trajectoryId) || event.trajectoryId !== `run:${event.runId}` ||
    !SHA256_RE.test(event.objectiveHash ?? '') ||
    event.learningSource !== 'daemon-dispatch' ||
    event.labelBasis !== 'dispatch-outcome' ||
    !boundedStoredText(event.routerPolicyVersion, 80) ||
    !SHA256_RE.test(event.repairHandoffId ?? '') ||
    !SHA256_RE.test(event.repairGenerationId ?? '') ||
    repairGenerationIdFromHandoffId(event.repairHandoffId!) !== event.repairGenerationId ||
    (event.repairAttemptOrdinal !== 1 && event.repairAttemptOrdinal !== 2) ||
    !SHA256_RE.test(event.repairRootId ?? '') ||
    (event.repairDepth !== 0 && event.repairDepth !== 1) ||
    !Number.isFinite(event.spentUsd) || event.spentUsd < 0
  ) return null;

  if (event.repairAttemptOrdinal === 1) {
    if (hasOwn(raw, 'repairPreviousBackend')) return null;
  } else if (
    !ENGINE_IDS.has(event.repairPreviousBackend as EngineId) ||
    event.repairPreviousBackend === 'builtin' ||
    event.repairPreviousBackend === event.backend
  ) return null;

  const route = event.routeSnapshot;
  if (!isPlainRecord(route) ||
    JSON.stringify(normalizeRouteSnapshot(route)) !== JSON.stringify(route) ||
    route['backend'] !== event.backend || route['tier'] !== event.tier ||
    hasOwn(route, 'model') !== hasOwn(raw, 'model') ||
    (hasOwn(route, 'model') && route['model'] !== event.model) ||
    route['assignedBy'] !== event.assignedBy ||
    route['routerPolicyVersion'] !== event.routerPolicyVersion) return null;

  const summary = event.runEventSummary;
  if (!isPlainRecord(summary) ||
    JSON.stringify(normalizeRunEventSummary(summary)) !== JSON.stringify(summary) ||
    summary['runId'] !== event.runId ||
    (summary['status'] !== 'done' && summary['status'] !== 'failed' && summary['status'] !== 'aborted') ||
    summary['outcome'] !== event.outcome || summary['proposalCreated'] !== false ||
    hasOwn(summary, 'proposalId') || summary['costUsd'] !== event.spentUsd ||
    (event.diffFiles !== undefined && summary['diffFiles'] !== undefined &&
      summary['diffFiles'] !== event.diffFiles) ||
    (event.diffLines !== undefined && summary['diffLines'] !== undefined &&
      summary['diffLines'] !== event.diffLines)) return null;

  const actionCounts = summary['actionCounts'];
  if (actionCounts !== undefined && (!isPlainRecord(actionCounts) ||
    (hasOwn(actionCounts, 'proposalCreated') && actionCounts['proposalCreated'] !== 0) ||
    (event.diffFiles !== undefined && actionCounts['diffFiles'] !== undefined &&
      actionCounts['diffFiles'] !== event.diffFiles) ||
    (summary['diffFiles'] !== undefined && actionCounts['diffFiles'] !== undefined &&
      actionCounts['diffFiles'] !== summary['diffFiles']) ||
    (event.diffLines !== undefined && actionCounts['diffLines'] !== undefined &&
      actionCounts['diffLines'] !== event.diffLines) ||
    (summary['diffLines'] !== undefined && actionCounts['diffLines'] !== undefined &&
      actionCounts['diffLines'] !== summary['diffLines']))) return null;

  return {
    event,
    proof: {
      schemaVersion: 1,
      integrityClass: 'owner-writable-local',
      cryptographicallyTrusted: false,
      rollbackProtected: false,
      eventTs: event.ts,
      eventDigest: createHash('sha256').update(line, 'utf8').digest('hex'),
      attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId),
      backend: event.backend,
      tier: event.tier,
      model: event.model ?? null,
      previousBackend: event.repairAttemptOrdinal === 2
        ? event.repairPreviousBackend as Exclude<EngineId, 'builtin'>
        : null,
      repairHandoffId: event.repairHandoffId!,
      repairGenerationId: event.repairGenerationId!,
      repairAttemptOrdinal: event.repairAttemptOrdinal,
    },
  };
}

export function validDispatchProductionAttemptProofTarget(
  target: DispatchProductionAttemptProofTarget,
): { date: string; sequenceStartDate: string; sequenceEndDate: string; repo: string } | null {
  if (!isPlainRecord(target)) return null;
  const ts = canonicalUtcTimestamp(target.ts);
  const sequenceStartTs = canonicalUtcTimestamp(target.sequenceStartTs ?? target.ts);
  const sequenceEndTs = canonicalUtcTimestamp(target.sequenceEndTs ?? target.ts);
  const repo = canonicalDispatchRepoIdentity(target.repo);
  const proposalCreated = target.outcome === 'proposal-created';
  if (
    ts === null || sequenceStartTs === null || sequenceEndTs === null ||
    Date.parse(sequenceStartTs) > Date.parse(ts) || Date.parse(ts) > Date.parse(sequenceEndTs) || repo === null ||
    !boundedStoredText(target.itemId, 240) ||
    !/:proposal-repair-nodiff:[0-9a-f]{12}$/.test(target.itemId) ||
    target.source !== 'self' ||
    (target.outcome !== 'empty-diff' && target.outcome !== 'proposal-created') ||
    (proposalCreated
      ? !boundedStoredText(target.proposalId, 160) || !isSafeExecutionIdentity(target.proposalId)
      : hasOwn(target, 'proposalId')) ||
    !SHA256_RE.test(target.objectiveHash) ||
    !SHA256_RE.test(target.repairHandoffId) ||
    !SHA256_RE.test(target.repairGenerationId) ||
    repairGenerationIdFromHandoffId(target.repairHandoffId) !== target.repairGenerationId ||
    !SHA256_RE.test(target.repairTreatmentUnitId) ||
    !REPAIR_TREATMENTS.includes(target.repairTreatment) ||
    repairTreatmentForUnitId(target.repairTreatmentUnitId) !== target.repairTreatment ||
    (target.repairAttemptOrdinal !== 1 && target.repairAttemptOrdinal !== 2)
  ) return null;
  return {
    date: ts.slice(0, 10),
    sequenceStartDate: sequenceStartTs.slice(0, 10),
    sequenceEndDate: sequenceEndTs.slice(0, 10),
    repo,
  };
}

export function sameBigIntSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function safeBigIntDirectory(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() &&
    (process.platform === 'win32' || typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

export function stablyMissingDispatchProductionDirectory(dir: string): boolean {
  const root = dirname(dir);
  try {
    const before = lstatSync(root, { bigint: true });
    if (!safeBigIntDirectory(before)) return false;
    const realBefore = realpathSync(root);
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      root,
      'directory',
      'inspect-owned',
      { anchorPath: root },
    ).ok) return false;
    try {
      lstatSync(dir);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const after = lstatSync(root, { bigint: true });
    try {
      lstatSync(dir);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    return safeBigIntDirectory(after) && sameBigIntSnapshot(before, after) && realBefore === realpathSync(root);
  } catch {
    return false;
  }
}

export function attemptProofReadReason(reason: StableFileReadFailureReason): DispatchProductionAttemptProofDegradedReason {
  switch (reason) {
    case 'unsafe-path':
    case 'unsafe-file':
      return 'source-unsafe';
    case 'changed-during-read':
      return 'source-mutated';
    case 'per-file-byte-limit':
    case 'byte-limit':
      return 'partition-byte-limit';
    default:
      return 'partition-unreadable';
  }
}

export function attemptProofLookupKey(ts: string, itemId: string, repo: string): string {
  return JSON.stringify([ts, itemId, repo]);
}

export function stablyMissingAttemptProofPartition(
  dir: string,
  path: string,
  root: string,
): DispatchProductionAttemptWitnessResolution {
  const guard = openStableDirectoryGuard(dir, { anchorPath: root });
  if (!guard.ok) {
    const reason = guard.reason === 'unsafe-path' || guard.reason === 'unsafe-file'
      ? 'source-unsafe'
      : guard.reason === 'missing'
        ? 'source-mutated'
        : attemptProofReadReason(guard.reason);
    return { status: 'degraded', reason };
  }
  let missing = false;
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
  }
  const guardFailure = guard.finish();
  if (guardFailure !== null || !missing) return { status: 'degraded', reason: 'source-mutated' };
  return { status: 'missing', reason: 'partition-missing' };
}

export function attemptSequenceKey(target: DispatchProductionAttemptProofTarget, repo: string): string {
  void repo;
  return target.repairGenerationId;
}

function attemptSequenceKeyFromEvent(event: DispatchProductionEvent): string | null {
  if (
    event.basis !== 'run-proposal-outcome' ||
    typeof event.repairGenerationId !== 'string' ||
    (event.repairAttemptOrdinal !== 1 && event.repairAttemptOrdinal !== 2)
  ) return null;
  return event.repairGenerationId;
}

export function listAttemptProofPartitionDates(
  dir: string,
  root: string,
): { ok: true; dates: string[] } |
  { ok: false; reason: DispatchProductionAttemptProofDegradedReason } {
  const guard = openStableDirectoryGuard(dir, { anchorPath: root });
  if (!guard.ok) {
    return {
      ok: false,
      reason: guard.reason === 'unsafe-path' || guard.reason === 'unsafe-file'
        ? 'source-unsafe'
        : guard.reason === 'missing'
          ? 'source-mutated'
          : attemptProofReadReason(guard.reason),
    };
  }
  const dates: string[] = [];
  try {
    let entryLimitExceeded = false;
    const handle = opendirSync(dir);
    try {
      let physical = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physical++;
        if (physical > MAX_DIRECTORY_ENTRIES) {
          entryLimitExceeded = true;
          break;
        }
        const match = DATE_LEDGER_FILE_RE.exec(entry.name);
        if (match) dates.push(match[1]!);
      }
    } finally { handle.closeSync(); }
    const guardFailure = guard.finish();
    if (guardFailure !== null) return { ok: false, reason: 'source-mutated' };
    if (entryLimitExceeded) return { ok: false, reason: 'date-limit' };
    return { ok: true, dates: [...new Set(dates)].sort() };
  } catch {
    guard.finish();
    return { ok: false, reason: 'partition-unreadable' };
  }
}

export function parseAttemptProofPartition(
  text: string,
  bytesRead: number,
  date: string,
  remainingRows: number,
  wantedKeys: ReadonlySet<string>,
  wantedSequenceKeys: ReadonlySet<string>,
): { ok: true; matches: Map<string, ParsedDispatchProductionPartitionMatch>;
  sequenceMatches: Map<string, ParsedDispatchProductionSequenceMatch[]>; rowsRead: number } |
  { ok: false; reason: 'partition-invalid' | 'partition-row-limit'; rowsRead: number } {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') !== bytesRead || !text.endsWith('\n')) {
    return { ok: false, reason: 'partition-invalid', rowsRead: 0 };
  }
  const matches = new Map<string, ParsedDispatchProductionPartitionMatch>();
  const sequenceMatches = new Map<string, ParsedDispatchProductionSequenceMatch[]>();
  let rowsRead = 0;
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\n', offset);
    if (end < 0) return { ok: false, reason: 'partition-invalid', rowsRead };
    const line = text.slice(offset, end);
    offset = end + 1;
    rowsRead++;
    if (rowsRead > remainingRows) return { ok: false, reason: 'partition-row-limit', rowsRead };
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
      return { ok: false, reason: 'partition-invalid', rowsRead };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return { ok: false, reason: 'partition-invalid', rowsRead }; }
    if (!canonicalStoredDispatchProductionEvent(parsed, line, date)) {
      return { ok: false, reason: 'partition-invalid', rowsRead };
    }
    const lineAuthority = parseDispatchProductionAttemptAuthority(parsed, line);
    const failureAuthority = parseDispatchProductionFailureAttemptAuthority(parsed, line);
    const sequenceKey = failureAuthority === null ? attemptSequenceKeyFromEvent(parsed) : null;
    if (sequenceKey && wantedSequenceKeys.has(sequenceKey)) {
      const entries = sequenceMatches.get(sequenceKey) ?? [];
      entries.push({
        row: lineAuthority,
        eventDigest: createHash('sha256').update(line, 'utf8').digest('hex'),
        ordinal: parsed.repairAttemptOrdinal!,
        ts: parsed.ts,
      });
      sequenceMatches.set(sequenceKey, entries);
    }
    const key = attemptProofLookupKey(parsed.ts, parsed.itemId, parsed.repo);
    if (!wantedKeys.has(key)) continue;
    const eventDigest = createHash('sha256').update(line, 'utf8').digest('hex');
    const previous = matches.get(key);
    if (previous) {
      if (previous.eventDigest !== eventDigest) previous.conflict = true;
      continue;
    }
    matches.set(key, {
      event: parsed,
      eventDigest,
      row: lineAuthority,
      conflict: false,
    });
  }
  return { ok: true, matches, sequenceMatches, rowsRead };
}

function readAttemptProofPartitionWithContext(
  date: string,
  context: AttemptReceiptBatchReadContext,
): AttemptReceiptCachedPartition {
  const cached = context.partitionCache.get(date);
  if (cached) return cached;
  const path = join(dispatchProductionDir(), `${date}.jsonl`);
  if (!existsSync(path)) {
    const missing = { ok: true as const, sequenceMatches: new Map() };
    context.partitionCache.set(date, missing);
    return missing;
  }
  if (context.filesRead >= HARD_READ_MAX_FILES) {
    const limited = { ok: false as const, reason: 'date-limit' as const };
    context.partitionCache.set(date, limited);
    return limited;
  }
  if (context.bytesRead >= HARD_READ_MAX_BYTES) {
    const limited = { ok: false as const, reason: 'partition-byte-limit' as const };
    context.partitionCache.set(date, limited);
    return limited;
  }
  if (context.rowsRead >= HARD_READ_MAX_ROWS) {
    const limited = { ok: false as const, reason: 'partition-row-limit' as const };
    context.partitionCache.set(date, limited);
    return limited;
  }
  context.filesRead++;
  const loaded = readStableRegularFile(path, {
    anchorPath: dirname(dispatchProductionDir()),
    maxFileBytes: HARD_READ_MAX_BYTES,
    remainingBytes: HARD_READ_MAX_BYTES - context.bytesRead,
  });
  if (!loaded.ok) {
    const failed = { ok: false as const, reason: attemptProofReadReason(loaded.reason) };
    context.partitionCache.set(date, failed);
    return failed;
  }
  context.bytesRead += loaded.bytesRead;
  const parsed = parseAttemptProofPartition(
    loaded.text,
    loaded.bytesRead,
    date,
    HARD_READ_MAX_ROWS - context.rowsRead,
    new Set(),
    context.wantedGenerationIds,
  );
  context.rowsRead = Math.min(HARD_READ_MAX_ROWS, context.rowsRead + parsed.rowsRead);
  const result: AttemptReceiptCachedPartition = parsed.ok
    ? { ok: true, sequenceMatches: parsed.sequenceMatches }
    : { ok: false, reason: parsed.reason };
  context.partitionCache.set(date, result);
  return result;
}

export function readBoundedLegacyAttemptGenerationMembership(
  dates: readonly string[],
): { ok: true; membership: AttemptGenerationMembership } |
  { ok: false; reason: DispatchProductionAttemptProofDegradedReason } {
  if (dates.length > MAX_DIRECTORY_ENTRIES) return { ok: false, reason: 'date-limit' };
  const dir = dispatchProductionDir();
  const root = dirname(dir);
  const bits = Buffer.alloc(ATTEMPT_BLOCKED_MEMBERSHIP_BYTES);
  let totalBytes = 0;
  let totalRows = 0;
  for (const date of dates) {
    if (totalBytes >= HARD_READ_MAX_BYTES) return { ok: false, reason: 'partition-byte-limit' };
    if (totalRows >= HARD_READ_MAX_ROWS) return { ok: false, reason: 'partition-row-limit' };
    const loaded = readStableRegularFile(join(dir, `${date}.jsonl`), {
      anchorPath: root,
      maxFileBytes: HARD_READ_MAX_BYTES,
      remainingBytes: HARD_READ_MAX_BYTES - totalBytes,
    });
    if (!loaded.ok) return { ok: false, reason: attemptProofReadReason(loaded.reason) };
    totalBytes += loaded.bytesRead;
    if (loaded.text.length === 0 ||
      Buffer.byteLength(loaded.text, 'utf8') !== loaded.bytesRead ||
      !loaded.text.endsWith('\n')) {
      return { ok: false, reason: 'partition-invalid' };
    }
    let offset = 0;
    while (offset < loaded.text.length) {
      const end = loaded.text.indexOf('\n', offset);
      if (end < 0) return { ok: false, reason: 'partition-invalid' };
      const line = loaded.text.slice(offset, end);
      offset = end + 1;
      totalRows++;
      if (totalRows > HARD_READ_MAX_ROWS) return { ok: false, reason: 'partition-row-limit' };
      if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
        return { ok: false, reason: 'partition-invalid' };
      }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return { ok: false, reason: 'partition-invalid' }; }
      if (!canonicalStoredDispatchProductionEvent(parsed, line, date)) {
        return { ok: false, reason: 'partition-invalid' };
      }
      const generationId = attemptSequenceKeyFromEvent(parsed);
      if (generationId !== null) setAttemptGenerationMembershipBits(bits, generationId);
    }
  }
  return {
    ok: true,
    membership: {
      ...emptyAttemptGenerationMembership(),
      bits: bits.toString('base64'),
    },
  };
}

function readBoundedRawAttemptSequence(
  generationId: string,
  context?: AttemptReceiptBatchReadContext,
):
  { ok: true; matches: ParsedDispatchProductionSequenceMatch[] } |
  { ok: false; reason: DispatchProductionAttemptProofDegradedReason } {
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return { ok: true, matches: [] };
  const root = dirname(dir);
  if (context) {
    context.partitionDates ??= listAttemptProofPartitionDates(dir, root);
    if (!context.partitionDates.ok) return context.partitionDates;
    if (context.partitionDates.dates.length > HARD_READ_MAX_FILES) {
      return { ok: false, reason: 'date-limit' };
    }
    const matches: ParsedDispatchProductionSequenceMatch[] = [];
    for (const date of context.partitionDates.dates) {
      const partition = readAttemptProofPartitionWithContext(date, context);
      if (!partition.ok) return partition;
      matches.push(...(partition.sequenceMatches.get(generationId) ?? []));
    }
    return { ok: true, matches };
  }
  const partitions = listAttemptProofPartitionDates(dir, root);
  if (!partitions.ok) return partitions;
  if (partitions.dates.length > HARD_READ_MAX_FILES) return { ok: false, reason: 'date-limit' };

  const matches: ParsedDispatchProductionSequenceMatch[] = [];
  let totalBytes = 0;
  let totalRows = 0;
  for (const date of partitions.dates) {
    if (totalBytes >= HARD_READ_MAX_BYTES) return { ok: false, reason: 'partition-byte-limit' };
    if (totalRows >= HARD_READ_MAX_ROWS) return { ok: false, reason: 'partition-row-limit' };
    const loaded = readStableRegularFile(join(dir, `${date}.jsonl`), {
      anchorPath: root,
      maxFileBytes: HARD_READ_MAX_BYTES,
      remainingBytes: HARD_READ_MAX_BYTES - totalBytes,
    });
    if (!loaded.ok) return { ok: false, reason: attemptProofReadReason(loaded.reason) };
    totalBytes += loaded.bytesRead;
    const parsed = parseAttemptProofPartition(
      loaded.text,
      loaded.bytesRead,
      date,
      HARD_READ_MAX_ROWS - totalRows,
      new Set(),
      new Set([generationId]),
    );
    totalRows += parsed.rowsRead;
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    matches.push(...(parsed.sequenceMatches.get(generationId) ?? []));
  }
  return { ok: true, matches };
}

function readBoundedRawAttemptSequenceSince(
  generationId: string,
  notBefore: string,
  context?: AttemptReceiptBatchReadContext,
): { ok: true; matches: ParsedDispatchProductionSequenceMatch[] } |
  { ok: false; reason: DispatchProductionAttemptProofDegradedReason } {
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return { ok: true, matches: [] };
  const batch: AttemptReceiptBatchReadContext = context ?? {
    wantedGenerationIds: new Set([generationId]),
    partitionCache: new Map<string, AttemptReceiptCachedPartition>(),
    filesRead: 0,
    bytesRead: 0,
    rowsRead: 0,
  };
  batch.partitionDates ??= listAttemptProofPartitionDates(dir, dirname(dir));
  if (!batch.partitionDates.ok) return batch.partitionDates;
  const firstDate = notBefore.slice(0, 10);
  const dates = batch.partitionDates.dates.filter((date) => date >= firstDate);
  if (dates.length > HARD_READ_MAX_FILES) return { ok: false, reason: 'date-limit' };
  const cutoff = Date.parse(notBefore);
  const matches: ParsedDispatchProductionSequenceMatch[] = [];
  for (const date of dates) {
    const partition = readAttemptProofPartitionWithContext(date, batch);
    if (!partition.ok) return partition;
    matches.push(...(partition.sequenceMatches.get(generationId) ?? [])
      .filter((match) => Date.parse(match.ts) >= cutoff));
  }
  return { ok: true, matches };
}

export function attemptProofEventMatchesTarget(
  event: DispatchProductionEvent,
  target: DispatchProductionAttemptProofTarget,
  repo: string,
): boolean {
  return event.ts === target.ts &&
    event.itemId === target.itemId &&
    event.repo === repo &&
    event.source === target.source &&
    event.outcome === target.outcome &&
    event.proposalId === target.proposalId &&
    event.objectiveHash === target.objectiveHash &&
    event.repairHandoffId === target.repairHandoffId &&
    event.repairGenerationId === target.repairGenerationId &&
    event.repairTreatmentUnitId === target.repairTreatmentUnitId &&
    event.repairTreatment === target.repairTreatment &&
    event.repairAttemptOrdinal === target.repairAttemptOrdinal;
}

export type AttemptProofReceiptRead =
  | { status: 'missing' }
  | { status: 'intent'; authority: ParsedDispatchProductionAttemptAuthority }
  | { status: 'proven'; authority: ParsedDispatchProductionAttemptAuthority }
  | { status: 'unproven'; reason: 'event-ineligible' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

type AttemptReceiptRetentionRead =
  | { status: 'none' }
  | { status: 'retained'; droppedThrough: string }
  | { status: 'degraded' };

function validateLegacyAttemptProofReceipt(
  authority: ParsedDispatchProductionAttemptAuthority,
  context?: AttemptReceiptBatchReadContext,
): AttemptProofReceiptRead | null {
  const history = readBoundedRawAttemptSequence(authority.proof.repairGenerationId, context);
  if (!history.ok) return { status: 'degraded', reason: history.reason };
  const sameOrdinal = [...new Map(history.matches
    .filter((match) => match.ordinal === authority.proof.repairAttemptOrdinal)
    .map((match) => [match.eventDigest, match])).values()];
  if (sameOrdinal.length === 0) return { status: 'degraded', reason: 'source-unavailable' };
  if (sameOrdinal.length !== 1 || sameOrdinal[0]!.row === null ||
    sameOrdinal[0]!.eventDigest !== authority.proof.eventDigest) {
    return { status: 'degraded', reason: 'partition-conflict' };
  }
  return null;
}

function validateProtocolAttemptProofReceipt(
  authority: ParsedDispatchProductionAttemptAuthority,
  activation: AttemptReceiptProtocolActivation,
  context?: AttemptReceiptBatchReadContext,
): AttemptProofReceiptRead | null {
  const generation = activation.generations.find((entry) =>
    entry.generationId === authority.proof.repairGenerationId);
  if (!generation ||
    Date.parse(authority.event.ts) < Date.parse(activation.acceptsEventsAfter) ||
    Date.parse(authority.event.ts) < Date.parse(generation.admittedAt)) {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
  const history = readBoundedRawAttemptSequenceSince(
    authority.proof.repairGenerationId,
    generation.admittedAt,
    context,
  );
  if (!history.ok) return { status: 'degraded', reason: history.reason };
  const sameOrdinal = [...new Map(history.matches
    .filter((match) => match.ordinal === authority.proof.repairAttemptOrdinal)
    .map((match) => [match.eventDigest, match])).values()];
  if (sameOrdinal.length === 0) return { status: 'intent', authority };
  if (sameOrdinal.length !== 1 || sameOrdinal[0]!.row === null ||
    sameOrdinal[0]!.eventDigest !== authority.proof.eventDigest) {
    return { status: 'degraded', reason: 'partition-conflict' };
  }
  return null;
}

export function readAttemptReceiptRetention(): AttemptReceiptRetentionRead {
  try {
    const retention = readAttemptReceiptRetentionState();
    return retention.droppedThrough === null
      ? { status: 'none' }
      : { status: 'retained', droppedThrough: retention.droppedThrough };
  } catch {
    return { status: 'degraded' };
  }
}

export function readAttemptProofReceipt(
  generationId: string,
  ordinal: 1 | 2,
  validateRaw = true,
  knownActivation?: AttemptReceiptProtocolActivation | null,
  context?: AttemptReceiptBatchReadContext,
): AttemptProofReceiptRead {
  const dir = attemptProofReceiptDir();
  if (existsSync(dir)) {
    try { inspectExactReceiptAuthorityDirectory(dir); } catch {
      return { status: 'degraded', reason: 'source-unsafe' };
    }
  }
  const path = join(dir, attemptProofReceiptName(generationId, ordinal));
  let activation = knownActivation;
  if (activation === undefined) {
    try { activation = readAttemptReceiptProtocolActivation(); } catch {
      return { status: 'degraded', reason: 'source-unavailable' };
    }
  }
  const generation = activation?.generations.find((entry) => entry.generationId === generationId);
  if (!generation && activation && membershipSetSaturated(activation.blockedGenerations)) {
    return { status: 'degraded', reason: 'retirement-membership-saturated' };
  }
  if (!generation && activation && attemptGenerationMembershipHas(
    activation.blockedGenerations, generationId,
  )) return {
    status: 'degraded',
    reason: membershipSetSaturated(activation.blockedGenerations)
      ? 'retirement-membership-saturated'
      : 'source-unavailable',
  };
  if (existsSync(path)) {
    return readAttemptProofReceiptFile(path, generationId, ordinal, validateRaw, activation, context);
  }
  const intentPath = attemptReceiptIntentPath(generationId, ordinal);
  if (existsSync(intentPath)) {
    return readAttemptProofReceiptFile(intentPath, generationId, ordinal, validateRaw, activation, context);
  }
  return { status: 'missing' };
}

export function readAttemptProofReceiptFile(
  path: string,
  generationId: string,
  ordinal: 1 | 2,
  validateRaw = true,
  knownActivation?: AttemptReceiptProtocolActivation | null,
  context?: AttemptReceiptBatchReadContext,
): AttemptProofReceiptRead {
  try { inspectExactReceiptAuthorityFile(path); } catch {
    return { status: 'degraded', reason: 'source-unsafe' };
  }
  const remainingBytes = context ? HARD_READ_MAX_BYTES - context.bytesRead : MAX_READ_ROW_BYTES;
  if (remainingBytes <= 0) return { status: 'degraded', reason: 'partition-byte-limit' };
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_READ_ROW_BYTES,
    remainingBytes: Math.min(MAX_READ_ROW_BYTES, remainingBytes),
  });
  if (!loaded.ok) return { status: 'degraded', reason: attemptProofReadReason(loaded.reason) };
  if (context) context.bytesRead += loaded.bytesRead;
  if (!loaded.text.endsWith('\n') || loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  const receiptLine = loaded.text.slice(0, -1);
  let parsed: unknown;
  try { parsed = JSON.parse(receiptLine); } catch { return { status: 'degraded', reason: 'partition-invalid' }; }
  let validated = false;
  let activationId: string | null = null;
  let line = receiptLine;
  if (isPlainRecord(parsed) && parsed['receiptSchemaVersion'] === 1) {
    if (!hasOnlyKeys(parsed, new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'event',
    ])) || parsed['validation'] !== ATTEMPT_RECEIPT_VALIDATION ||
      typeof parsed['activationId'] !== 'string' || !SHA256_RE.test(parsed['activationId'])) {
      return { status: 'degraded', reason: 'partition-invalid' };
    }
    activationId = parsed['activationId'];
    parsed = parsed['event'];
    line = JSON.stringify(parsed);
    validated = true;
  }
  const ts = isPlainRecord(parsed) ? canonicalUtcTimestamp(parsed['ts']) : null;
  if (ts === null || !canonicalStoredDispatchProductionEvent(parsed, line, ts.slice(0, 10))) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  if (validated) {
    if (receiptLine !== attemptReceiptEnvelope(parsed, activationId!)) {
      return { status: 'degraded', reason: 'partition-invalid' };
    }
    try {
      const activation = knownActivation === undefined
        ? readAttemptReceiptProtocolActivation()
        : knownActivation;
      if (activation === null || activation.activationId !== activationId) {
        return { status: 'degraded', reason: 'source-unavailable' };
      }
      const generation = activation.generations.find((entry) => entry.generationId === generationId);
      if (!generation) {
        return { status: 'degraded', reason: 'source-unavailable' };
      }
    } catch {
      return { status: 'degraded', reason: 'source-unavailable' };
    }
  }
  const authority = parseDispatchProductionAttemptAuthority(parsed, line);
  if (authority === null) return { status: 'unproven', reason: 'event-ineligible' };
  if (
    authority.proof.repairGenerationId !== generationId ||
    authority.proof.repairAttemptOrdinal !== ordinal
  ) return { status: 'degraded', reason: 'partition-conflict' };
  if (!validateRaw) return { status: 'proven', authority };
  if (!validated) {
    const legacyFailure = validateLegacyAttemptProofReceipt(authority, context);
    if (legacyFailure !== null) return legacyFailure;
  } else {
    let activation: AttemptReceiptProtocolActivation | null;
    try {
      activation = knownActivation === undefined
        ? readAttemptReceiptProtocolActivation()
        : knownActivation;
    } catch {
      return { status: 'degraded', reason: 'source-unavailable' };
    }
    if (activation === null) return { status: 'degraded', reason: 'source-unavailable' };
    const protocolFailure = validateProtocolAttemptProofReceipt(authority, activation, context);
    if (protocolFailure !== null && !(
      protocolFailure.status === 'intent' && ATTEMPT_RECEIPT_FILE_RE.test(basename(path))
    )) return protocolFailure;
  }
  return { status: 'proven', authority };
}
