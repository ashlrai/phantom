/** Attempt receipt, witness, and proof resolution. */

import type {
  DispatchProductionFailureAttemptReceiptResolution,
  DispatchProductionEvent,
  DispatchProductionFailureAttemptReceiptTarget,
  DispatchProductionFailureAttemptReceiptBatchResolution,
  DispatchProductionFailureAttemptProof,
  DispatchProductionAttemptProofTarget,
  DispatchProductionAttemptWitnessResolution,
  DispatchProductionAttemptProofDegradedReason,
  DispatchProductionAttemptProofBatchResolution,
  DispatchProductionAttemptWitnessBatchResolution,
  DispatchProductionAttemptReceiptWitnessTarget,
  DispatchProductionAttemptReceiptWitnessBatchResolution,
  DispatchProductionAttemptReceiptWitnessResolution,
  DispatchProductionAttemptReceiptAvailabilityBatchResolution,
  DispatchProductionAttemptReceiptAvailabilityResolution,
  DispatchProductionAttemptProofResolution,
} from './types.js';
import {
  type AttemptFailureAppendAuthority,
  parseAttemptFailureAppendAuthority,
  attemptFailureReceiptEnvelope,
  attemptReceiptEnvelope,
  attemptFailureReceiptIntentPath,
} from './write.js';
import {
  type AttemptReceiptProtocolActivation,
  readAttemptReceiptProtocolActivation,
  membershipSetSaturated,
  attemptGenerationMembershipHas,
} from './attempt-retention.js';
import {
  type StableFileBatchAssurance,
  readStableRegularFile,
} from '../../util/stable-file-read.js';
import {
  inspectExactReceiptAuthorityFile,
  dispatchProductionDir,
  attemptProofReceiptDir,
  inspectExactReceiptAuthorityDirectory,
  attemptFailureReceiptName,
  safeDispatchProductionFile,
  ReceiptDirectoryAuthorityError,
  UNSAFE_RECEIPT_DIRECTORY_REASONS,
} from './storage.js';
import {
  MAX_ATTEMPT_FAILURE_RECEIPT_BYTES,
  ATTEMPT_RECEIPT_VALIDATION,
  SHA256_RE,
  MAX_ATTEMPT_PROOF_RECEIPTS,
  MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES,
  ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE,
  ATTEMPT_FAILURE_RECEIPT_FILE_RE,
  MAX_ATTEMPT_FAILURE_RECEIPT_AGGREGATE_BYTES,
  HARD_ATTEMPT_PROOF_TARGETS,
  DAY_MS,
  HARD_READ_MAX_FILES,
  HARD_READ_MAX_BYTES,
  HARD_READ_MAX_ROWS,
} from './constants.js';
import {
  attemptProofReadReason,
  isPlainRecord,
  hasOnlyKeys,
  canonicalUtcTimestamp,
  canonicalStoredDispatchProductionEvent,
  parseDispatchProductionFailureAttemptAuthority,
  type AttemptReceiptBatchReadContext,
  type AttemptProofReceiptRead,
  readAttemptProofReceipt,
  readAttemptReceiptRetention,
  attemptProofEventMatchesTarget,
  type ParsedDispatchProductionAttemptAuthority,
  validDispatchProductionAttemptProofTarget,
  attemptSequenceKey,
  attemptProofLookupKey,
  stablyMissingDispatchProductionDirectory,
  listAttemptProofPartitionDates,
  type ParsedDispatchProductionSequenceMatch,
  stablyMissingAttemptProofPartition,
  parseAttemptProofPartition,
} from './attempt-proofs.js';
import { existsSync, opendirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assureRetentionFiles } from './retention-hooks.js';

type FailureAttemptReceiptFileRead =
  | Exclude<DispatchProductionFailureAttemptReceiptResolution, { status: 'proven' }>
  | (Extract<DispatchProductionFailureAttemptReceiptResolution, { status: 'proven' }> & {
      appendAuthority?: AttemptFailureAppendAuthority;
    });

export function readFailureAttemptReceiptFile(
  path: string,
  generationId: string,
  ordinal: 1 | 2,
  attemptHash: string,
  knownActivation?: AttemptReceiptProtocolActivation | null,
  batchAssurance?: StableFileBatchAssurance,
): FailureAttemptReceiptFileRead {
  try { if (!batchAssurance) inspectExactReceiptAuthorityFile(path); } catch {
    return { status: 'degraded', reason: 'source-unsafe' };
  }
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_ATTEMPT_FAILURE_RECEIPT_BYTES,
    remainingBytes: MAX_ATTEMPT_FAILURE_RECEIPT_BYTES,
    ...(batchAssurance ? { batchAssurance } : {}),
  });
  if (!loaded.ok) return { status: 'degraded', reason: attemptProofReadReason(loaded.reason) };
  if (!loaded.text.endsWith('\n') || loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  const receiptLine = loaded.text.slice(0, -1);
  let envelope: unknown;
  try { envelope = JSON.parse(receiptLine); } catch {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  if (!isPlainRecord(envelope) ||
    (envelope['receiptSchemaVersion'] !== 1 && envelope['receiptSchemaVersion'] !== 2) ||
    !hasOnlyKeys(envelope, envelope['receiptSchemaVersion'] === 2 ? new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'appendAuthority', 'event',
    ]) : new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'event',
    ])) ||
    envelope['validation'] !== ATTEMPT_RECEIPT_VALIDATION ||
    typeof envelope['activationId'] !== 'string' || !SHA256_RE.test(envelope['activationId'])) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  const event = envelope['event'];
  const line = JSON.stringify(event);
  const canonicalRow = Buffer.from(`${line}\n`, 'utf8');
  const ts = isPlainRecord(event) ? canonicalUtcTimestamp(event['ts']) : null;
  const appendAuthority = envelope['receiptSchemaVersion'] === 2 && isPlainRecord(event)
    ? parseAttemptFailureAppendAuthority(
        envelope['appendAuthority'], event as unknown as DispatchProductionEvent, canonicalRow,
      )
    : undefined;
  const canonicalEnvelope = envelope['receiptSchemaVersion'] === 2 && appendAuthority
    ? attemptFailureReceiptEnvelope(event as DispatchProductionEvent, envelope['activationId'], appendAuthority)
    : attemptReceiptEnvelope(event as DispatchProductionEvent, envelope['activationId']);
  if (ts === null || !canonicalStoredDispatchProductionEvent(event, line, ts.slice(0, 10)) ||
    (envelope['receiptSchemaVersion'] === 2 && !appendAuthority) ||
    receiptLine !== canonicalEnvelope) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  let activation: AttemptReceiptProtocolActivation | null;
  try {
    activation = knownActivation === undefined
      ? readAttemptReceiptProtocolActivation()
      : knownActivation;
  } catch {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
  const generation = activation?.generations.find((entry) => entry.generationId === generationId);
  if (!activation || activation.activationId !== envelope['activationId'] || !generation ||
    Date.parse(ts) < Date.parse(activation.acceptsEventsAfter) ||
    Date.parse(ts) < Date.parse(generation.admittedAt)) {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
  const authority = parseDispatchProductionFailureAttemptAuthority(event, line);
  if (authority === null) return { status: 'unproven', reason: 'event-ineligible' };
  if (authority.proof.repairGenerationId !== generationId ||
    authority.proof.repairAttemptOrdinal !== ordinal ||
    authority.proof.attemptHash !== attemptHash) {
    return { status: 'unproven', reason: 'target-mismatch' };
  }
  return {
    status: 'proven',
    proof: authority.proof,
    event: structuredClone(authority.event),
    ...(appendAuthority ? { appendAuthority } : {}),
  };
}

function retiredFailureAttemptResolution(
  activation: AttemptReceiptProtocolActivation | null,
  generationId: string,
): Extract<DispatchProductionFailureAttemptReceiptResolution, { status: 'degraded' }> | null {
  if (activation === null || activation.generations.some((entry) => entry.generationId === generationId)) {
    return null;
  }
  if (membershipSetSaturated(activation.blockedGenerations)) {
    return { status: 'degraded', reason: 'retirement-membership-saturated' };
  }
  return attemptGenerationMembershipHas(activation.blockedGenerations, generationId)
    ? { status: 'degraded', reason: 'source-unavailable' }
    : null;
}

export function resolveDispatchProductionFailureAttemptReceipt(
  target: DispatchProductionFailureAttemptReceiptTarget,
): DispatchProductionFailureAttemptReceiptResolution {
  if (!isPlainRecord(target) ||
    !hasOnlyKeys(target, new Set(['repairGenerationId', 'repairAttemptOrdinal', 'attemptHash'])) ||
    !SHA256_RE.test(target.repairGenerationId) || !SHA256_RE.test(target.attemptHash) ||
    (target.repairAttemptOrdinal !== 1 && target.repairAttemptOrdinal !== 2)) {
    return { status: 'degraded', reason: 'target-invalid' };
  }
  const dir = attemptProofReceiptDir();
  try {
    if (existsSync(dir)) inspectExactReceiptAuthorityDirectory(dir);
    const activation = readAttemptReceiptProtocolActivation();
    const retired = retiredFailureAttemptResolution(activation, target.repairGenerationId);
    if (retired !== null) return retired;
    const path = join(dir, attemptFailureReceiptName(
      target.repairGenerationId, target.repairAttemptOrdinal, target.attemptHash,
    ));
    if (existsSync(path)) {
      const loaded = readFailureAttemptReceiptFile(
        path,
        target.repairGenerationId,
        target.repairAttemptOrdinal,
        target.attemptHash,
        activation,
      );
      return loaded.status === 'proven'
        ? { status: 'proven', proof: loaded.proof, event: loaded.event }
        : loaded;
    }
    const intentPath = attemptFailureReceiptIntentPath(
      target.repairGenerationId, target.repairAttemptOrdinal, target.attemptHash,
    );
    if (existsSync(intentPath)) {
      const pending = readFailureAttemptReceiptFile(
        intentPath,
        target.repairGenerationId,
        target.repairAttemptOrdinal,
        target.attemptHash,
        activation,
      );
      return pending.status === 'proven'
        ? { status: 'missing', reason: 'receipt-uncommitted' }
        : pending;
    }
    return { status: 'missing', reason: 'receipt-missing' };
  } catch {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
}

export function readDispatchProductionFailureAttemptReceipts(
  generationIds: readonly string[],
): DispatchProductionFailureAttemptReceiptBatchResolution {
  if (generationIds.length > MAX_ATTEMPT_PROOF_RECEIPTS ||
    generationIds.some((generationId) => !SHA256_RE.test(generationId))) {
    return { status: 'degraded', reason: 'target-limit' };
  }
  const wanted = new Set(generationIds);
  if (wanted.size === 0) return { status: 'resolved', authoritative: false, receipts: [] };
  const dir = attemptProofReceiptDir();
  try {
    if (!existsSync(dir)) return { status: 'resolved', authoritative: false, receipts: [] };
    inspectExactReceiptAuthorityDirectory(dir);
    const activation = readAttemptReceiptProtocolActivation();
    if (activation === null) return { status: 'degraded', reason: 'source-unavailable' };
    for (const generationId of wanted) {
      const retired = retiredFailureAttemptResolution(activation, generationId);
      if (retired !== null) return retired;
    }
    const files: Array<{ name: string; generationId: string; ordinal: 1 | 2; attemptHash: string }> = [];
    let aggregateBytes = 0;
    const handle = opendirSync(dir);
    try {
      let physical = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physical++;
        if (physical > MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES) {
          return { status: 'degraded', reason: 'date-limit' };
        }
        const intent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(entry.name);
        if (intent && wanted.has(intent[1]!)) {
          return { status: 'degraded', reason: 'source-unavailable' };
        }
        const match = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(entry.name);
        if (!match || !wanted.has(match[1]!)) continue;
        if (files.length >= MAX_ATTEMPT_PROOF_RECEIPTS) {
          return { status: 'degraded', reason: 'target-limit' };
        }
        const stat = lstatSync(join(dir, entry.name));
        if (!safeDispatchProductionFile(stat) || stat.size > MAX_ATTEMPT_FAILURE_RECEIPT_BYTES) {
          return { status: 'degraded', reason: 'source-unsafe' };
        }
        aggregateBytes += stat.size;
        if (aggregateBytes > MAX_ATTEMPT_FAILURE_RECEIPT_AGGREGATE_BYTES) {
          return { status: 'degraded', reason: 'partition-byte-limit' };
        }
        files.push({
          name: entry.name,
          generationId: match[1]!,
          ordinal: Number(match[2]) as 1 | 2,
          attemptHash: match[3]!,
        });
      }
    } finally { handle.closeSync(); }
    const receipts: Array<{ proof: DispatchProductionFailureAttemptProof; event: DispatchProductionEvent }> = [];
    for (let offset = 0; offset < files.length; offset += 512) {
      const batch = files.slice(offset, offset + 512);
      const paths = batch.map((file) => join(dir, file.name));
      const assurance = assureRetentionFiles(paths, dispatchProductionDir());
      if (!assurance.ok) return { status: 'degraded', reason: attemptProofReadReason(assurance.reason) };
      for (let index = 0; index < batch.length; index++) {
        const file = batch[index]!;
        const resolution = readFailureAttemptReceiptFile(
          paths[index]!,
          file.generationId,
          file.ordinal,
          file.attemptHash,
          activation,
          assurance.token,
        );
        if (resolution.status !== 'proven') {
          return resolution.status === 'degraded'
            ? resolution
            : { status: 'degraded', reason: 'partition-invalid' };
        }
        receipts.push({ proof: resolution.proof, event: resolution.event });
      }
    }
    receipts.sort((left, right) => Date.parse(left.event.ts) - Date.parse(right.event.ts));
    return { status: 'resolved', authoritative: true, receipts };
  } catch {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
}

function readAttemptProofReceiptSequence(
  generationId: string,
  knownActivation?: AttemptReceiptProtocolActivation | null,
  context?: AttemptReceiptBatchReadContext,
):
  { status: 'resolved'; first: AttemptProofReceiptRead; second: AttemptProofReceiptRead } {
  return {
    status: 'resolved',
    first: readAttemptProofReceipt(generationId, 1, true, knownActivation, context),
    second: readAttemptProofReceipt(generationId, 2, true, knownActivation, context),
  };
}

function resolveAttemptProofReceipt(
  target: DispatchProductionAttemptProofTarget,
  repo: string,
): DispatchProductionAttemptWitnessResolution | null {
  const receipt = readAttemptProofReceipt(target.repairGenerationId, target.repairAttemptOrdinal);
  if (receipt.status === 'missing') {
    const retention = readAttemptReceiptRetention();
    if (retention.status === 'degraded' ||
      (retention.status === 'retained' && Date.parse(target.ts) <= Date.parse(retention.droppedThrough))) {
      return { status: 'degraded', reason: 'source-unavailable' };
    }
    return null;
  }
  if (receipt.status === 'intent') return null;
  if (receipt.status !== 'proven') return receipt;
  const authority = receipt.authority;
  if (!attemptProofEventMatchesTarget(authority.event, target, repo)) {
    return { status: 'unproven', reason: 'target-mismatch' };
  }
  return {
    status: 'proven',
    proof: authority.proof,
    event: structuredClone(authority.event),
  };
}

function receiptSequenceConflict(
  first: ParsedDispatchProductionAttemptAuthority,
  second: ParsedDispatchProductionAttemptAuthority,
): boolean {
  return first.event.outcome === 'proposal-created' ||
    Date.parse(first.event.ts) > Date.parse(second.event.ts) ||
    first.proof.attemptHash === second.proof.attemptHash ||
    second.proof.previousBackend !== first.proof.backend ||
    second.proof.tier !== first.proof.tier ||
    second.event.itemId !== first.event.itemId ||
    second.event.repo !== first.event.repo ||
    second.event.source !== first.event.source ||
    second.event.objectiveHash !== first.event.objectiveHash ||
    second.proof.repairHandoffId !== first.proof.repairHandoffId ||
    second.proof.repairTreatmentUnitId !== first.proof.repairTreatmentUnitId ||
    second.proof.repairTreatment !== first.proof.repairTreatment;
}

type FailureAttemptPredecessor =
  | { status: 'proven' }
  | { status: 'missing' }
  | { status: 'conflict' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

function failureAttemptPredecessor(
  generationId: string,
  second: ParsedDispatchProductionAttemptAuthority,
): FailureAttemptPredecessor {
  const batch = readDispatchProductionFailureAttemptReceipts([generationId]);
  if (batch.status === 'degraded') return batch;
  const firsts = batch.receipts.filter((receipt) => receipt.proof.repairAttemptOrdinal === 1);
  if (firsts.length === 0) return { status: 'missing' };
  if (firsts.length !== 1) return { status: 'conflict' };
  const first = firsts[0]!;
  const sameRoot = second.event.repairRootId === undefined || (
    first.event.repairRootId === second.event.repairRootId &&
    first.event.repairDepth === second.event.repairDepth
  );
  return Date.parse(first.event.ts) <= Date.parse(second.event.ts) &&
    first.proof.attemptHash !== second.proof.attemptHash &&
    first.proof.backend === second.proof.previousBackend &&
    first.proof.tier === second.proof.tier &&
    first.event.itemId === second.event.itemId &&
    first.event.repo === second.event.repo &&
    first.event.source === second.event.source &&
    first.event.objectiveHash === second.event.objectiveHash &&
    first.proof.repairHandoffId === second.proof.repairHandoffId &&
    first.proof.repairGenerationId === second.proof.repairGenerationId &&
    first.proof.repairTreatmentUnitId === second.proof.repairTreatmentUnitId &&
    first.proof.repairTreatment === second.proof.repairTreatment &&
    sameRoot
    ? { status: 'proven' }
    : { status: 'conflict' };
}

function resolveReceiptCompleteAttemptSequence(
  targets: readonly DispatchProductionAttemptProofTarget[],
  indexes: readonly number[],
  repos: ReadonlyMap<number, string>,
): Map<number, DispatchProductionAttemptWitnessResolution> | null {
  const firstTarget = targets[indexes[0]!]!;
  const needsSecond = indexes.some((index) => targets[index]!.repairAttemptOrdinal === 2);
  const sequence = readAttemptProofReceiptSequence(firstTarget.repairGenerationId);
  if (sequence.first.status === 'intent' ||
    (needsSecond && (sequence.second.status === 'missing' || sequence.second.status === 'intent'))) return null;

  const { first, second } = sequence;
  const uniform = (
    resolution: DispatchProductionAttemptWitnessResolution,
  ): Map<number, DispatchProductionAttemptWitnessResolution> => new Map(
    indexes.map((index) => [index, resolution]),
  );
  if (first.status !== 'proven' && first.status !== 'missing') return uniform(first);
  if (second.status !== 'missing' && second.status !== 'intent' && second.status !== 'proven') {
    return uniform(second);
  }
  const failurePredecessor = first.status === 'missing' && second.status === 'proven'
    ? failureAttemptPredecessor(firstTarget.repairGenerationId, second.authority)
    : { status: 'missing' as const };
  if (failurePredecessor.status === 'degraded') return uniform(failurePredecessor);
  if (failurePredecessor.status === 'conflict') {
    return uniform({ status: 'unproven', reason: 'attempt-sequence-mismatch' });
  }
  if (first.status === 'missing' && failurePredecessor.status !== 'proven') return null;
  if (first.status === 'proven' && second.status === 'proven' &&
    receiptSequenceConflict(first.authority, second.authority)) {
    return uniform({ status: 'unproven', reason: 'attempt-sequence-mismatch' });
  }

  const result = new Map<number, DispatchProductionAttemptWitnessResolution>();
  for (const index of indexes) {
    const target = targets[index]!;
    const repo = repos.get(index)!;
    const receipt = target.repairAttemptOrdinal === 1 ? first : second;
    if (receipt.status !== 'proven') {
      result.set(index, { status: 'unproven', reason: 'attempt-sequence-missing' });
    } else if (!attemptProofEventMatchesTarget(receipt.authority.event, target, repo)) {
      result.set(index, { status: 'unproven', reason: 'target-mismatch' });
    } else {
      result.set(index, {
        status: 'proven',
        proof: receipt.authority.proof,
        event: structuredClone(receipt.authority.event),
      });
    }
  }
  return result;
}

/**
 * Resolve metadata-only generated-repair attempt proof from a complete immutable
 * receipt sequence, or conservatively from stable dispatch-production partitions
 * for legacy/incomplete generations. Routing and attempt identity are always
 * derived from persisted bytes rather than trusted from the caller.
 */
export function resolveDispatchProductionAttemptProofs(
  targets: readonly DispatchProductionAttemptProofTarget[],
): DispatchProductionAttemptProofBatchResolution {
  const witnessed = resolveDispatchProductionAttemptWitnesses(targets);
  if (witnessed.status !== 'resolved') return witnessed;
  return {
    status: 'resolved',
    resolutions: witnessed.resolutions.map((resolution) =>
      resolution.status === 'proven'
        ? { status: 'proven', proof: resolution.proof }
        : resolution),
  };
}

export function resolveDispatchProductionAttemptWitnesses(
  targets: readonly DispatchProductionAttemptProofTarget[],
): DispatchProductionAttemptWitnessBatchResolution {
  if (targets.length > HARD_ATTEMPT_PROOF_TARGETS) {
    return { status: 'degraded', reason: 'target-limit' };
  }
  return { status: 'resolved', resolutions: resolveBoundedDispatchProductionAttemptProofs(targets) };
}

const ATTEMPT_RECEIPT_WITNESS_TARGET_KEYS = new Set([
  'repairGenerationId',
  'repairAttemptOrdinal',
]);

/**
 * Read canonical metadata-only attempt witnesses directly from immutable
 * generation receipts. This bounded recovery API never enumerates production
 * partitions and validates the complete available sequence before returning it.
 */
export function resolveDispatchProductionAttemptReceiptWitnesses(
  targets: readonly DispatchProductionAttemptReceiptWitnessTarget[],
): DispatchProductionAttemptReceiptWitnessBatchResolution {
  if (targets.length > HARD_ATTEMPT_PROOF_TARGETS) {
    return { status: 'degraded', reason: 'target-limit' };
  }
  const resolutions: DispatchProductionAttemptReceiptWitnessResolution[] = Array.from(
    { length: targets.length },
    () => ({ status: 'degraded', reason: 'target-invalid' }),
  );
  const byGeneration = new Map<string, number[]>();
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    if (
      !isPlainRecord(target) ||
      !hasOnlyKeys(target, ATTEMPT_RECEIPT_WITNESS_TARGET_KEYS) ||
      !SHA256_RE.test(target.repairGenerationId) ||
      (target.repairAttemptOrdinal !== 1 && target.repairAttemptOrdinal !== 2)
    ) continue;
    const indexes = byGeneration.get(target.repairGenerationId) ?? [];
    indexes.push(index);
    byGeneration.set(target.repairGenerationId, indexes);
  }

  const context: AttemptReceiptBatchReadContext = {
    wantedGenerationIds: new Set(byGeneration.keys()),
    partitionCache: new Map(),
    filesRead: 0,
    bytesRead: 0,
    rowsRead: 0,
  };
  let activation: AttemptReceiptProtocolActivation | null = null;
  if (byGeneration.size > 0) {
    const receiptDir = attemptProofReceiptDir();
    if (existsSync(receiptDir)) {
      try { inspectExactReceiptAuthorityDirectory(receiptDir); } catch (error) {
        const reason = error instanceof ReceiptDirectoryAuthorityError &&
          UNSAFE_RECEIPT_DIRECTORY_REASONS.has(error.reason)
          ? 'source-unsafe' as const
          : 'source-unavailable' as const;
        for (const indexes of byGeneration.values()) {
          for (const index of indexes) {
            resolutions[index] = { status: 'degraded', reason };
          }
        }
        return { status: 'resolved', resolutions };
      }
    }
    try { activation = readAttemptReceiptProtocolActivation(context, true); } catch {
      for (const indexes of byGeneration.values()) {
        for (const index of indexes) {
          resolutions[index] = { status: 'degraded', reason: 'source-unavailable' };
        }
      }
      return { status: 'resolved', resolutions };
    }
  }

  for (const [generationId, indexes] of byGeneration) {
    const sequence = readAttemptProofReceiptSequence(generationId, activation, context);
    const { first, second } = sequence;
    const receiptFailure = first.status !== 'missing' && first.status !== 'intent' && first.status !== 'proven'
      ? first
      : second.status !== 'missing' && second.status !== 'intent' && second.status !== 'proven'
        ? second
        : null;
    if (receiptFailure !== null) {
      for (const index of indexes) resolutions[index] = receiptFailure;
      continue;
    }
    if (first.status === 'proven' && second.status === 'proven' &&
      receiptSequenceConflict(first.authority, second.authority)) {
      for (const index of indexes) {
        resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
      }
      continue;
    }
    const needsFailurePredecessor = indexes.some((index) =>
      targets[index]!.repairAttemptOrdinal === 2) &&
      first.status === 'missing' && second.status === 'proven';
    const failurePredecessor = needsFailurePredecessor
      ? failureAttemptPredecessor(generationId, second.authority)
      : { status: 'missing' as const };
    if (failurePredecessor.status === 'degraded' || failurePredecessor.status === 'conflict') {
      const resolution: DispatchProductionAttemptReceiptWitnessResolution =
        failurePredecessor.status === 'degraded'
          ? failurePredecessor
          : { status: 'unproven', reason: 'attempt-sequence-mismatch' };
      for (const index of indexes) resolutions[index] = resolution;
      continue;
    }

    for (const index of indexes) {
      const target = targets[index]!;
      const receipt = target.repairAttemptOrdinal === 1 ? first : second;
      if (receipt.status === 'intent') {
        resolutions[index] = { status: 'missing', reason: 'receipt-uncommitted' };
      } else if (receipt.status === 'missing') {
        resolutions[index] = { status: 'missing', reason: 'receipt-missing' };
      } else if (target.repairAttemptOrdinal === 2 &&
        (first.status === 'intent' ||
          (first.status === 'missing' && failurePredecessor.status !== 'proven'))) {
        resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-missing' };
      } else if (receipt.status !== 'proven') {
        resolutions[index] = receipt;
      } else {
        resolutions[index] = {
          status: 'proven',
          proof: receipt.authority.proof,
          event: structuredClone(receipt.authority.event),
        };
      }
    }
  }
  return { status: 'resolved', resolutions };
}

/**
 * Observationally distinguish an absent receipt with no matching authoritative
 * append from a receipt that is missing after its raw append committed.
 */
export function readDispatchProductionAttemptReceiptAvailability(
  targets: readonly DispatchProductionAttemptProofTarget[],
): DispatchProductionAttemptReceiptAvailabilityBatchResolution {
  if (targets.length > HARD_ATTEMPT_PROOF_TARGETS) {
    return { status: 'degraded', reason: 'target-limit' };
  }
  const resolutions: DispatchProductionAttemptReceiptAvailabilityResolution[] = Array.from(
    { length: targets.length },
    () => ({ status: 'degraded', reason: 'target-invalid' }),
  );
  const valid = new Map<number, { repo: string }>();
  const receiptTargets: DispatchProductionAttemptReceiptWitnessTarget[] = [];
  const receiptIndexes: number[] = [];
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const parsed = validDispatchProductionAttemptProofTarget(target);
    if (!parsed) continue;
    valid.set(index, { repo: parsed.repo });
    receiptTargets.push({
      repairGenerationId: target.repairGenerationId,
      repairAttemptOrdinal: target.repairAttemptOrdinal,
    });
    receiptIndexes.push(index);
  }

  const receipts = resolveDispatchProductionAttemptReceiptWitnesses(receiptTargets);
  if (receipts.status !== 'resolved') return receipts;
  const rawTargets: DispatchProductionAttemptProofTarget[] = [];
  const rawIndexes: number[] = [];
  for (let offset = 0; offset < receipts.resolutions.length; offset++) {
    const index = receiptIndexes[offset]!;
    const receipt = receipts.resolutions[offset]!;
    if (receipt.status === 'proven') {
      const target = targets[index]!;
      if (!attemptProofEventMatchesTarget(receipt.event, target, valid.get(index)!.repo)) {
        resolutions[index] = { status: 'unproven', reason: 'target-mismatch' };
      } else {
        resolutions[index] = {
          status: 'available',
          proof: receipt.proof,
          event: structuredClone(receipt.event),
        };
      }
    } else if (receipt.status === 'missing') {
      rawTargets.push(targets[index]!);
      rawIndexes.push(index);
    } else {
      resolutions[index] = receipt;
    }
  }

  if (rawTargets.length > 0) {
    const raw = resolveBoundedDispatchProductionAttemptProofs(rawTargets, false);
    for (let offset = 0; offset < raw.length; offset++) {
      const index = rawIndexes[offset]!;
      const resolution = raw[offset]!;
      if (resolution.status === 'proven') {
        resolutions[index] = {
          status: 'missing',
          reason: 'receipt-missing-after-append',
          proof: resolution.proof,
          event: structuredClone(resolution.event),
        };
      } else if (resolution.status === 'missing') {
        resolutions[index] = { status: 'missing', reason: 'raw-append-missing' };
      } else {
        resolutions[index] = resolution;
      }
    }
  }
  return { status: 'resolved', resolutions };
}

function resolveBoundedDispatchProductionAttemptProofs(
  targets: readonly DispatchProductionAttemptProofTarget[],
  allowReceiptFastPath = true,
): DispatchProductionAttemptWitnessResolution[] {
  const resolutions: DispatchProductionAttemptWitnessResolution[] = Array.from({ length: targets.length }, () => ({
    status: 'degraded', reason: 'target-invalid',
  }));
  const byDate = new Map<string, Array<{ index: number; repo: string; key: string; sequenceKey: string }>>();
  const sequences = new Map<string, { first: number[]; second: number[] }>();
  const sequenceWindows = new Map<string, { start: string; end: string; indexes: number[] }>();
  const validRepos = new Map<number, string>();
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const valid = validDispatchProductionAttemptProofTarget(target);
    if (!valid) continue;
    const sequenceKey = attemptSequenceKey(target, valid.repo);
    const entries = byDate.get(valid.date) ?? [];
    entries.push({
      index,
      repo: valid.repo,
      key: attemptProofLookupKey(target.ts, target.itemId, valid.repo),
      sequenceKey,
    });
    byDate.set(valid.date, entries);
    validRepos.set(index, valid.repo);
    const sequence = sequences.get(sequenceKey) ?? { first: [], second: [] };
    sequence[target.repairAttemptOrdinal === 1 ? 'first' : 'second'].push(index);
    sequences.set(sequenceKey, sequence);
    const window = sequenceWindows.get(sequenceKey) ?? {
      start: valid.sequenceStartDate,
      end: valid.sequenceEndDate,
      indexes: [],
    };
    if (valid.sequenceStartDate < window.start) window.start = valid.sequenceStartDate;
    if (valid.sequenceEndDate > window.end) window.end = valid.sequenceEndDate;
    window.indexes.push(index);
    sequenceWindows.set(sequenceKey, window);
  }
  if (byDate.size === 0) return resolutions;

  const receiptCompleteSequences = new Set<string>();
  if (allowReceiptFastPath) {
    for (const [sequenceKey, sequence] of sequences) {
      const indexes = [...sequence.first, ...sequence.second];
      const receiptResolution = resolveReceiptCompleteAttemptSequence(targets, indexes, validRepos);
      if (receiptResolution === null) continue;
      for (const [index, resolution] of receiptResolution) resolutions[index] = resolution;
      receiptCompleteSequences.add(sequenceKey);
    }
  }
  if (receiptCompleteSequences.size > 0) {
    for (const [date, entries] of byDate) {
      const remaining = entries.filter((entry) => !receiptCompleteSequences.has(entry.sequenceKey));
      if (remaining.length === 0) byDate.delete(date);
      else byDate.set(date, remaining);
    }
    for (const sequenceKey of receiptCompleteSequences) {
      sequences.delete(sequenceKey);
      sequenceWindows.delete(sequenceKey);
    }
  }
  if (byDate.size === 0) return resolutions;

  const receiptResolutions = new Map<number, DispatchProductionAttemptWitnessResolution>();
  if (allowReceiptFastPath) {
    for (const entries of byDate.values()) for (const entry of entries) {
      const receipt = resolveAttemptProofReceipt(targets[entry.index]!, entry.repo);
      if (receipt !== null) {
        receiptResolutions.set(entry.index, receipt);
        resolutions[entry.index] = receipt;
      }
    }
  }
  const sequenceIndexesByDate = new Map<string, Set<number>>();
  for (const window of sequenceWindows.values()) {
    let cursor = Date.parse(`${window.start}T00:00:00.000Z`);
    const end = Date.parse(`${window.end}T00:00:00.000Z`);
    if (!Number.isFinite(cursor) || !Number.isFinite(end)) continue;
    while (cursor <= end) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      const indexes = sequenceIndexesByDate.get(date) ?? new Set<number>();
      for (const index of window.indexes) indexes.add(index);
      sequenceIndexesByDate.set(date, indexes);
      cursor += DAY_MS;
      if (byDate.size > HARD_READ_MAX_FILES) break;
    }
    if (byDate.size > HARD_READ_MAX_FILES) break;
  }
  if (byDate.size > HARD_READ_MAX_FILES) {
    for (const window of sequenceWindows.values()) for (const index of window.indexes) {
      resolutions[index] = { status: 'degraded', reason: 'date-limit' };
    }
    return resolutions;
  }

  const dir = dispatchProductionDir();
  const root = dirname(dir);
  if (!existsSync(dir)) {
    const stableMissing = stablyMissingDispatchProductionDirectory(dir);
    for (const entries of byDate.values()) {
      for (const entry of entries) resolutions[entry.index] = stableMissing
        ? { status: 'missing', reason: 'partition-missing' }
        : { status: 'degraded', reason: 'source-unavailable' };
    }
    return resolutions;
  }

  const durablePartitions = listAttemptProofPartitionDates(dir, root);
  if (!durablePartitions.ok) {
    for (const window of sequenceWindows.values()) for (const index of window.indexes) {
      resolutions[index] = { status: 'degraded', reason: durablePartitions.reason };
    }
    return resolutions;
  }
  const allValidIndexes = [...sequenceWindows.values()].flatMap((window) => window.indexes);
  for (const date of durablePartitions.dates) {
    if (!byDate.has(date)) byDate.set(date, []);
    const indexes = sequenceIndexesByDate.get(date) ?? new Set<number>();
    for (const index of allValidIndexes) indexes.add(index);
    sequenceIndexesByDate.set(date, indexes);
  }
  if (byDate.size > HARD_READ_MAX_FILES) {
    for (const index of allValidIndexes) resolutions[index] = { status: 'degraded', reason: 'date-limit' };
    return resolutions;
  }

  let totalBytes = 0;
  let totalRows = 0;
  const sequenceMatches = new Map<string, ParsedDispatchProductionSequenceMatch[]>();
  const wantedSequenceKeys = new Set(sequences.keys());
  const sequenceDegradations = new Map<number, DispatchProductionAttemptProofDegradedReason>();
  for (const [date, entries] of byDate) {
    const relatedIndexes = sequenceIndexesByDate.get(date) ?? new Set(entries.map((entry) => entry.index));
    const degradeRelated = (reason: DispatchProductionAttemptProofDegradedReason): void => {
      for (const index of relatedIndexes) if (!sequenceDegradations.has(index)) {
        sequenceDegradations.set(index, reason);
      }
    };
    if (totalBytes >= HARD_READ_MAX_BYTES) {
      degradeRelated('partition-byte-limit');
      continue;
    }
    if (totalRows >= HARD_READ_MAX_ROWS) {
      degradeRelated('partition-row-limit');
      continue;
    }
    const path = join(dir, `${date}.jsonl`);
    let dateResolutions: DispatchProductionAttemptWitnessResolution[];
    try {
      let partitionMissing = false;
      try { lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') partitionMissing = true;
        else throw error;
      }
      if (partitionMissing) {
        const missing = stablyMissingAttemptProofPartition(dir, path, root);
        dateResolutions = entries.map(() => missing);
        if (missing.status === 'degraded') degradeRelated(missing.reason);
      } else {
        const loaded = readStableRegularFile(path, {
          anchorPath: root,
          maxFileBytes: HARD_READ_MAX_BYTES,
          remainingBytes: Math.max(0, HARD_READ_MAX_BYTES - totalBytes),
        });
        if (!loaded.ok) {
          const reason = attemptProofReadReason(loaded.reason);
          degradeRelated(reason);
          dateResolutions = entries.map(() => ({
            status: 'degraded', reason,
          }));
        } else {
          totalBytes += loaded.bytesRead;
          const parsed = parseAttemptProofPartition(
            loaded.text,
            loaded.bytesRead,
            date,
            Math.max(0, HARD_READ_MAX_ROWS - totalRows),
            new Set(entries.map((entry) => entry.key)),
            wantedSequenceKeys,
          );
          totalRows += parsed.rowsRead;
          if (!parsed.ok) {
            degradeRelated(parsed.reason);
            dateResolutions = entries.map(() => ({ status: 'degraded', reason: parsed.reason }));
          } else {
            for (const [sequenceKey, matches] of parsed.sequenceMatches) {
              sequenceMatches.set(sequenceKey, [
                ...(sequenceMatches.get(sequenceKey) ?? []),
                ...matches,
              ]);
            }
            dateResolutions = entries.map((entry) => {
              const target = targets[entry.index]!;
              const match = parsed.matches.get(entry.key);
              if (!match) return { status: 'missing', reason: 'event-missing' };
              if (match.conflict) return { status: 'degraded', reason: 'partition-conflict' };
              if (match.row === null) return { status: 'unproven', reason: 'event-ineligible' };
              if (!attemptProofEventMatchesTarget(match.event, target, entry.repo)) {
                return { status: 'unproven', reason: 'target-mismatch' };
              }
              return {
                status: 'proven',
                proof: match.row.proof,
                event: structuredClone(match.row.event),
              };
            });
          }
        }
      }
    } catch {
      degradeRelated('partition-unreadable');
      dateResolutions = entries.map(() => ({ status: 'degraded', reason: 'partition-unreadable' }));
    }
    for (let offset = 0; offset < entries.length; offset++) {
      resolutions[entries[offset]!.index] = dateResolutions[offset]!;
    }
  }

  for (const [index, reason] of sequenceDegradations) {
    resolutions[index] = { status: 'degraded', reason };
  }
  for (const [index, receipt] of receiptResolutions) {
    if (receipt.status === 'degraded' || receipt.status === 'unproven') {
      resolutions[index] = receipt;
    } else if (receipt.status === 'proven' && resolutions[index]?.status === 'missing') {
      resolutions[index] = receipt;
    }
  }

  for (const [sequenceKey, sequence] of sequences) {
    const completeMatches = sequenceMatches.get(sequenceKey) ?? [];
    const firstRows = [...new Map(completeMatches
      .filter((match) => match.ordinal === 1)
      .map((match) => [match.eventDigest, match])).values()];
    const secondRows = [...new Map(completeMatches
      .filter((match) => match.ordinal === 2)
      .map((match) => [match.eventDigest, match])).values()];
    const uniqueFirstRows = new Set(firstRows.map((match) => match.eventDigest));
    const uniqueSecondRows = new Set(secondRows.map((match) => match.eventDigest));
    const observedFirst = firstRows.length === 1 ? firstRows[0]!.row : null;
    const observedSecond = secondRows.length === 1 ? secondRows[0]!.row : null;
    const sequenceConflict =
      uniqueFirstRows.size > 1 ||
      uniqueSecondRows.size > 1 ||
      firstRows.some((match) => match.row === null) ||
      secondRows.some((match) => match.row === null) ||
      (observedFirst !== null && observedSecond !== null && (
        observedFirst.event.outcome === 'proposal-created' ||
        observedFirst.proof.attemptHash === observedSecond.proof.attemptHash ||
        observedSecond.proof.previousBackend !== observedFirst.proof.backend ||
        observedSecond.proof.tier !== observedFirst.proof.tier
      ));
    if (sequenceConflict) {
      for (const index of [...sequence.first, ...sequence.second]) {
        if (resolutions[index]?.status === 'proven') {
          resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
        }
      }
      continue;
    }
    const degradedFirst = sequence.first.map((index) => resolutions[index])
      .find((resolution): resolution is Extract<DispatchProductionAttemptProofResolution, { status: 'degraded' }> =>
        resolution?.status === 'degraded');
    const firstProofs = sequence.first.flatMap((index) => {
      const resolution = resolutions[index];
      return resolution?.status === 'proven' ? [resolution.proof] : [];
    });
    const secondProofs = sequence.second.flatMap((index) => {
      const resolution = resolutions[index];
      return resolution?.status === 'proven' ? [resolution.proof] : [];
    });
    const firstAttemptHashes = new Set(firstProofs.map((proof) => proof.attemptHash));
    const secondAttemptHashes = new Set(secondProofs.map((proof) => proof.attemptHash));
    if (firstAttemptHashes.size > 1) {
      for (const index of [...sequence.first, ...sequence.second]) {
        if (resolutions[index]?.status === 'proven') {
          resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
        }
      }
      continue;
    }
    if (secondAttemptHashes.size > 1) {
      for (const index of sequence.second) {
        if (resolutions[index]?.status === 'proven') {
          resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
        }
      }
      continue;
    }
    for (const index of sequence.second) {
      const resolution = resolutions[index];
      if (resolution?.status !== 'proven') continue;
      if (degradedFirst) {
        resolutions[index] = { status: 'degraded', reason: degradedFirst.reason };
        continue;
      }
      if (firstProofs.length === 0) {
        resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-missing' };
        continue;
      }
      const firstBackends = new Set(firstProofs.map((proof) => proof.backend));
      const firstTiers = new Set(firstProofs.map((proof) => proof.tier));
      if (firstBackends.size !== 1 || firstTiers.size !== 1 ||
        resolution.proof.attemptHash === firstProofs[0]!.attemptHash ||
        resolution.proof.previousBackend !== firstProofs[0]!.backend ||
        resolution.proof.tier !== firstProofs[0]!.tier) {
        resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
      }
    }
  }
  return resolutions;
}
