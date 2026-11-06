/** Attempt receipt protocol activation, membership, and retention. */

import {
  ATTEMPT_BLOCKED_MEMBERSHIP_BITS,
  ATTEMPT_BLOCKED_MEMBERSHIP_HASHES,
  MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE,
  ATTEMPT_RETENTION_ARTIFACT_SET_DIGEST_DOMAIN,
  ATTEMPT_BLOCKED_MEMBERSHIP_BYTES,
  MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS,
  ATTEMPT_RECEIPT_PROTOCOL_FILE,
  HARD_READ_MAX_BYTES,
  MAX_ATTEMPT_PROTOCOL_BYTES,
  SHA256_RE,
  MAX_ATTEMPT_ACTIVE_GENERATIONS,
  MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE,
  MAX_ATTEMPT_RECEIPT_DIR_ENTRIES,
  ATTEMPT_RECEIPT_FILE_RE,
  ATTEMPT_RECEIPT_INTENT_FILE_RE,
  ATTEMPT_FAILURE_RECEIPT_FILE_RE,
  ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE,
  ATTEMPT_RECEIPT_RETENTION_FILE,
  MAX_ATTEMPT_FUTURE_SKEW_MS,
  MAX_READ_ROW_BYTES,
  ATTEMPT_RECEIPT_VALIDATION,
  MAX_ATTEMPT_RECEIPT_RETENTION_BYTES,
  MAX_ATTEMPT_PROOF_RECEIPTS,
  HARD_READ_MAX_FILES,
  HARD_READ_MAX_ROWS,
} from './constants.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  isPlainRecord,
  hasOnlyKeys,
  type AttemptReceiptBatchReadContext,
  canonicalUtcTimestamp,
  listAttemptProofPartitionDates,
  readBoundedLegacyAttemptGenerationMembership,
  canonicalStoredDispatchProductionEvent,
  parseDispatchProductionFailureAttemptAuthority,
  parseDispatchProductionAttemptAuthority,
  parseAttemptProofPartition,
} from './attempt-proofs.js';
import { join, dirname } from 'node:path';
import {
  attemptProofReceiptDir,
  inspectExactReceiptAuthorityDirectory,
  inspectExactReceiptAuthorityFile,
  dispatchProductionDir,
  safeDispatchProductionDirectory,
  assertStableDispatchProductionWriteRoot,
  secureCreatedReceiptTempFile,
  safeDispatchProductionFile,
  attemptProofReceiptName,
} from './storage.js';
import {
  existsSync,
  lstatSync,
  openSync,
  constants as fsConstants,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  opendirSync,
  unlinkSync,
} from 'node:fs';
import {
  readStableRegularFile,
  type StableFileBatchAssurance,
} from '../../util/stable-file-read.js';
import type { DispatchProductionAttemptProtocolQuality, DispatchProductionEvent } from './types.js';
import {
  attemptReceiptStagePath,
  cleanupDispatchProductionWriteTemp,
  parseAttemptFailureAppendAuthority,
  attemptFailureReceiptEnvelope,
  attemptReceiptEnvelope,
} from './write.js';
import { fsyncDirectory } from '../../util/durability.js';
import {
  assureRetentionFiles,
  dispatchProductionLedgerRetentionHooksForTest,
} from './retention-hooks.js';

interface AttemptReceiptProtocolGeneration {
  generationId: string;
  admittedAt: string;
}

export interface AttemptGenerationMembership {
  algorithm: 'sha256-bloom-v1';
  bitCount: typeof ATTEMPT_BLOCKED_MEMBERSHIP_BITS;
  hashCount: typeof ATTEMPT_BLOCKED_MEMBERSHIP_HASHES;
  bits: string;
}

interface AttemptGenerationMembershipSegment extends AttemptGenerationMembership {
  insertedCount: number;
  setBitCount: number;
}

interface AttemptGenerationMembershipSet {
  algorithm: 'segmented-sha256-bloom-v1';
  maxSegmentFalsePositiveRate: typeof MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE;
  quality: 'healthy' | 'saturated';
  segments: AttemptGenerationMembershipSegment[];
}

export class AttemptMembershipSaturatedError extends Error {
  constructor(readonly membership?: AttemptGenerationMembershipSet) {
    super('attempt retirement membership saturated');
    this.name = 'AttemptMembershipSaturatedError';
  }
}

export interface AttemptReceiptProtocolActivation {
  schemaVersion: 5;
  activationId: string;
  activatedAt: string;
  acceptsEventsAfter: string;
  retirementEpoch: number;
  generations: AttemptReceiptProtocolGeneration[];
  blockedGenerations: AttemptGenerationMembershipSet;
}

interface AttemptReceiptRetentionState {
  present: boolean;
  epochBound: boolean;
  droppedThrough: string | null;
  retirementEpoch: number;
  pendingGenerations: string[];
  pendingArtifacts: AttemptReceiptRetentionArtifacts;
}

interface AttemptReceiptRetentionArtifact {
  name: string;
  generationId: string;
  ordinal: 1 | 2;
  kind: 'receipt' | 'intent' | 'failure-receipt' | 'failure-intent';
  eventTs: string;
  eventDigest: string;
  fileDigest: string;
}

interface AttemptReceiptRetentionArtifactSet {
  count: number;
  digests: string[];
}

type AttemptReceiptRetentionArtifacts =
  | AttemptReceiptRetentionArtifact[]
  | AttemptReceiptRetentionArtifactSet;

function attemptRetentionArtifactSet(
  artifacts: readonly AttemptReceiptRetentionArtifact[],
): AttemptReceiptRetentionArtifactSet {
  const digests = artifacts.map((artifact) => createHash('sha256')
    .update(ATTEMPT_RETENTION_ARTIFACT_SET_DIGEST_DOMAIN, 'utf8')
    .update(JSON.stringify(artifact), 'utf8')
    .digest('hex')).sort();
  return {
    count: digests.length,
    digests,
  };
}

export function emptyAttemptGenerationMembership(): AttemptGenerationMembership {
  return {
    algorithm: 'sha256-bloom-v1',
    bitCount: ATTEMPT_BLOCKED_MEMBERSHIP_BITS,
    hashCount: ATTEMPT_BLOCKED_MEMBERSHIP_HASHES,
    bits: Buffer.alloc(ATTEMPT_BLOCKED_MEMBERSHIP_BYTES).toString('base64'),
  };
}

function countSetBits(bits: Buffer): number {
  let count = 0;
  for (const byte of bits) {
    let value = byte;
    while (value !== 0) {
      value &= value - 1;
      count++;
    }
  }
  return count;
}

function membershipSegment(
  membership: AttemptGenerationMembership,
  insertedCount = 0,
): AttemptGenerationMembershipSegment {
  const bits = attemptGenerationMembershipBuffer(membership);
  if (bits === null) throw new Error('invalid attempt generation membership');
  return { ...membership, insertedCount, setBitCount: countSetBits(bits) };
}

function emptyAttemptGenerationMembershipSet(): AttemptGenerationMembershipSet {
  return {
    algorithm: 'segmented-sha256-bloom-v1',
    maxSegmentFalsePositiveRate: MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE,
    quality: 'healthy',
    segments: [membershipSegment(emptyAttemptGenerationMembership())],
  };
}

function attemptGenerationMembershipBuffer(value: unknown): Buffer | null {
  const keys = isPlainRecord(value) ? Object.keys(value) : [];
  const validKeys = keys.length === 4
    ? new Set(['algorithm', 'bitCount', 'hashCount', 'bits'])
    : new Set(['algorithm', 'bitCount', 'hashCount', 'bits', 'insertedCount', 'setBitCount']);
  if (!isPlainRecord(value) ||
    (keys.length !== 4 && keys.length !== 6) ||
    !hasOnlyKeys(value, validKeys) ||
    value['algorithm'] !== 'sha256-bloom-v1' ||
    value['bitCount'] !== ATTEMPT_BLOCKED_MEMBERSHIP_BITS ||
    value['hashCount'] !== ATTEMPT_BLOCKED_MEMBERSHIP_HASHES ||
    typeof value['bits'] !== 'string') return null;
  const bits = Buffer.from(value['bits'], 'base64');
  if (bits.length !== ATTEMPT_BLOCKED_MEMBERSHIP_BYTES || bits.toString('base64') !== value['bits']) {
    return null;
  }
  return bits;
}

function attemptGenerationMembershipSet(value: unknown): AttemptGenerationMembershipSet | null {
  if (!isPlainRecord(value) ||
    !hasOnlyKeys(value, new Set(['algorithm', 'maxSegmentFalsePositiveRate', 'quality', 'segments'])) ||
    value['algorithm'] !== 'segmented-sha256-bloom-v1' ||
    value['maxSegmentFalsePositiveRate'] !== MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE ||
    (value['quality'] !== 'healthy' && value['quality'] !== 'saturated') ||
    !Array.isArray(value['segments']) || value['segments'].length < 1 ||
    value['segments'].length > MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS) return null;
  const segments: AttemptGenerationMembershipSegment[] = [];
  for (const segment of value['segments']) {
    const insertedCount = isPlainRecord(segment) ? segment['insertedCount'] : undefined;
    const setBitCount = isPlainRecord(segment) ? segment['setBitCount'] : undefined;
    if (!isPlainRecord(segment) || !hasOnlyKeys(segment, new Set([
      'algorithm', 'bitCount', 'hashCount', 'bits', 'insertedCount', 'setBitCount',
    ])) || typeof insertedCount !== 'number' || !Number.isSafeInteger(insertedCount) || insertedCount < 0 ||
      typeof setBitCount !== 'number' || !Number.isSafeInteger(setBitCount) || setBitCount < 0 ||
      setBitCount > ATTEMPT_BLOCKED_MEMBERSHIP_BITS) return null;
    const membership: AttemptGenerationMembership = {
      algorithm: segment['algorithm'] as AttemptGenerationMembership['algorithm'],
      bitCount: segment['bitCount'] as AttemptGenerationMembership['bitCount'],
      hashCount: segment['hashCount'] as AttemptGenerationMembership['hashCount'],
      bits: segment['bits'] as string,
    };
    const bits = attemptGenerationMembershipBuffer(membership);
    if (bits === null || countSetBits(bits) !== segment['setBitCount']) return null;
    segments.push({
      ...membership,
      insertedCount,
      setBitCount,
    });
  }
  const observedSaturation = segments.some((segment) =>
    membershipSegmentFalsePositiveRate(segment) > MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE);
  if (value['quality'] === 'healthy' && observedSaturation) return null;
  if (value['quality'] === 'saturated' &&
    !observedSaturation && segments.length !== MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS) return null;
  return {
    algorithm: 'segmented-sha256-bloom-v1',
    maxSegmentFalsePositiveRate: MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE,
    quality: value['quality'],
    segments,
  };
}

function membershipSegmentFalsePositiveRate(segment: AttemptGenerationMembershipSegment): number {
  return (segment.setBitCount / ATTEMPT_BLOCKED_MEMBERSHIP_BITS) ** ATTEMPT_BLOCKED_MEMBERSHIP_HASHES;
}

function membershipSetFalsePositiveRate(membership: AttemptGenerationMembershipSet): number {
  return Math.min(1, membership.segments.reduce(
    (total, segment) => total + membershipSegmentFalsePositiveRate(segment), 0,
  ));
}

export function membershipSetSaturated(membership: AttemptGenerationMembershipSet): boolean {
  return membership.quality === 'saturated';
}

function attemptGenerationMembershipIndexes(generationId: string): number[] {
  const digest = createHash('sha256')
    .update('ashlr:dispatch-attempt-generation-membership:v1\0', 'utf8')
    .update(generationId, 'utf8')
    .digest();
  return Array.from({ length: ATTEMPT_BLOCKED_MEMBERSHIP_HASHES }, (_, index) =>
    digest.readUInt32BE(index * 4) % ATTEMPT_BLOCKED_MEMBERSHIP_BITS);
}

export function attemptGenerationMembershipHas(
  membership: AttemptGenerationMembershipSet,
  generationId: string,
): boolean {
  return membership.segments.some((segment) => {
    const bits = attemptGenerationMembershipBuffer(segment);
    if (bits === null) throw new Error('invalid attempt generation membership');
    return attemptGenerationMembershipIndexes(generationId).every((index) =>
      (bits[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0);
  });
}

export function setAttemptGenerationMembershipBits(bits: Buffer, generationId: string): void {
  for (const index of attemptGenerationMembershipIndexes(generationId)) {
    bits[Math.floor(index / 8)]! |= 1 << (index % 8);
  }
}

function addAttemptGenerationMembership(
  membership: AttemptGenerationMembershipSet,
  generationIds: Iterable<string>,
): AttemptGenerationMembershipSet {
  if (membership.quality === 'saturated') throw new AttemptMembershipSaturatedError(membership);
  const segments = membership.segments.map((segment) => ({ ...segment }));
  for (const generationId of generationIds) {
    if (attemptGenerationMembershipHas({ ...membership, segments }, generationId)) continue;
    let active = segments.at(-1)!;
    let bits = attemptGenerationMembershipBuffer(active);
    if (bits === null) throw new Error('invalid attempt generation membership');
    const candidate = Buffer.from(bits);
    setAttemptGenerationMembershipBits(candidate, generationId);
    const candidateSetBits = countSetBits(candidate);
    const candidateRate = (candidateSetBits / ATTEMPT_BLOCKED_MEMBERSHIP_BITS) **
      ATTEMPT_BLOCKED_MEMBERSHIP_HASHES;
    if (candidateRate > MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE) {
      if (segments.length >= MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS) {
        throw new AttemptMembershipSaturatedError({
          ...membership,
          quality: 'saturated',
          segments,
        });
      }
      active = membershipSegment(emptyAttemptGenerationMembership());
      segments.push(active);
      bits = attemptGenerationMembershipBuffer(active)!;
      setAttemptGenerationMembershipBits(bits, generationId);
    } else bits = candidate;
    segments[segments.length - 1] = {
      ...active,
      bits: bits.toString('base64'),
      insertedCount: active.insertedCount + 1,
      setBitCount: countSetBits(bits),
    };
  }
  return { ...membership, segments };
}

function addAttemptGenerationMembershipPersistingQuality(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
  generationIds: Iterable<string>,
): AttemptGenerationMembershipSet {
  try {
    return addAttemptGenerationMembership(activation.blockedGenerations, generationIds);
  } catch (error) {
    if (error instanceof AttemptMembershipSaturatedError && error.membership) {
      writeAttemptReceiptProtocolActivation(dir, {
        ...activation,
        blockedGenerations: error.membership,
      });
    }
    throw error;
  }
}

export function readAttemptReceiptProtocolActivation(
  context?: AttemptReceiptBatchReadContext,
  directoryAlreadyInspected = false,
): AttemptReceiptProtocolActivation | null {
  const path = join(attemptProofReceiptDir(), ATTEMPT_RECEIPT_PROTOCOL_FILE);
  if (!existsSync(path)) return null;
  if (!directoryAlreadyInspected) inspectExactReceiptAuthorityDirectory(attemptProofReceiptDir());
  inspectExactReceiptAuthorityFile(path);
  const remainingBytes = context ? HARD_READ_MAX_BYTES - context.bytesRead : MAX_ATTEMPT_PROTOCOL_BYTES;
  if (remainingBytes <= 0) throw new Error('attempt receipt protocol byte limit');
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_ATTEMPT_PROTOCOL_BYTES,
    remainingBytes: Math.min(MAX_ATTEMPT_PROTOCOL_BYTES, remainingBytes),
  });
  if (!loaded.ok) throw new Error('invalid attempt receipt protocol activation');
  if (context) context.bytesRead += loaded.bytesRead;
  const parsed: unknown = JSON.parse(loaded.text);
  const protocolKeys = isPlainRecord(parsed) && parsed['schemaVersion'] === 5
    ? new Set([
      'schemaVersion', 'activationId', 'activatedAt', 'acceptsEventsAfter', 'retirementEpoch',
      'generations', 'blockedGenerations',
    ])
    : new Set([
      'schemaVersion', 'activationId', 'activatedAt', 'acceptsEventsAfter', 'generations',
      'blockedGenerations',
    ]);
  if (!isPlainRecord(parsed) ||
    !hasOnlyKeys(parsed, protocolKeys) ||
    (parsed['schemaVersion'] !== 3 && parsed['schemaVersion'] !== 4 && parsed['schemaVersion'] !== 5) ||
    (parsed['schemaVersion'] === 5 &&
      (!Number.isSafeInteger(parsed['retirementEpoch']) || (parsed['retirementEpoch'] as number) < 0)) ||
    typeof parsed['activationId'] !== 'string' || !SHA256_RE.test(parsed['activationId']) ||
    !Array.isArray(parsed['generations']) ||
    parsed['generations'].length > MAX_ATTEMPT_ACTIVE_GENERATIONS) {
    throw new Error('invalid attempt receipt protocol activation');
  }
  const activatedAt = canonicalUtcTimestamp(parsed['activatedAt']);
  const acceptsEventsAfter = canonicalUtcTimestamp(parsed['acceptsEventsAfter']);
  const legacyBlockedBits = parsed['schemaVersion'] === 3
    ? attemptGenerationMembershipBuffer(parsed['blockedGenerations'])
    : null;
  const legacySegment = parsed['schemaVersion'] === 3 && legacyBlockedBits !== null
    ? membershipSegment(parsed['blockedGenerations'] as unknown as AttemptGenerationMembership)
    : null;
  const blockedGenerations = parsed['schemaVersion'] === 3
    ? (legacySegment === null ? null : {
      algorithm: 'segmented-sha256-bloom-v1' as const,
      maxSegmentFalsePositiveRate: MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE as
      typeof MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE,
      quality: membershipSegmentFalsePositiveRate(legacySegment) >
        MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE
        ? 'saturated' as const
        : 'healthy' as const,
      segments: [legacySegment],
    })
    : attemptGenerationMembershipSet(parsed['blockedGenerations']);
  if (activatedAt === null || acceptsEventsAfter === null || blockedGenerations === null ||
    Date.parse(acceptsEventsAfter) > Date.parse(activatedAt)) {
    throw new Error('invalid attempt receipt protocol activation');
  }
  const generations: AttemptReceiptProtocolGeneration[] = [];
  const seen = new Set<string>();
  for (const value of parsed['generations']) {
    if (!isPlainRecord(value) ||
      !hasOnlyKeys(value, new Set(['generationId', 'admittedAt'])) ||
      typeof value['generationId'] !== 'string' || !SHA256_RE.test(value['generationId'])) {
      throw new Error('invalid attempt receipt generation history');
    }
    const admittedAt = canonicalUtcTimestamp(value['admittedAt']);
    if (admittedAt === null || seen.has(value['generationId'])) {
      throw new Error('invalid attempt receipt generation history');
    }
    seen.add(value['generationId']);
    generations.push({
      generationId: value['generationId'],
      admittedAt,
    });
  }
  if (generations.some((generation, index) =>
    index > 0 && generations[index - 1]!.generationId >= generation.generationId)) {
    throw new Error('invalid attempt receipt generation history');
  }
  return {
    schemaVersion: 5,
    activationId: parsed['activationId'],
    activatedAt,
    acceptsEventsAfter,
    retirementEpoch: parsed['schemaVersion'] === 5 ? parsed['retirementEpoch'] as number : 0,
    generations,
    blockedGenerations,
  };
}

export function readDispatchProductionAttemptProtocolQuality(): DispatchProductionAttemptProtocolQuality {
  try {
    const activation = readAttemptReceiptProtocolActivation();
    if (activation === null) {
      const dir = attemptProofReceiptDir();
      if (existsSync(dir)) {
        const stat = lstatSync(dir);
        if (!safeDispatchProductionDirectory(stat) ||
          (process.platform === 'win32' && (() => {
            try { inspectExactReceiptAuthorityDirectory(dir); return false; } catch { return true; }
          })()) || listAttemptReceiptAuthorityArtifacts(dir).length > 0) {
          throw new Error('attempt authority artifacts survive missing protocol');
        }
      }
      return {
        status: 'healthy',
        segmentCount: 0,
        estimatedFalsePositiveRate: 0,
        maxFalsePositiveRate: MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE,
      };
    }
    validateAttemptReceiptArtifactBindings(attemptProofReceiptDir(), activation);
    const estimatedFalsePositiveRate = membershipSetFalsePositiveRate(activation.blockedGenerations);
    return {
      status: membershipSetSaturated(activation.blockedGenerations) ? 'saturated' : 'healthy',
      segmentCount: activation.blockedGenerations.segments.length,
      estimatedFalsePositiveRate,
      maxFalsePositiveRate: MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE,
    };
  } catch {
    return {
      status: 'degraded',
      segmentCount: 0,
      estimatedFalsePositiveRate: 1,
      maxFalsePositiveRate: MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE,
    };
  }
}

function writeAttemptReceiptProtocolActivation(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
): void {
  assertStableDispatchProductionWriteRoot();
  const path = join(dir, ATTEMPT_RECEIPT_PROTOCOL_FILE);
  const tmp = attemptReceiptStagePath(path);
  const bytes = Buffer.from(`${JSON.stringify(activation)}\n`, 'utf8');
  if (bytes.length > MAX_ATTEMPT_PROTOCOL_BYTES) throw new Error('attempt receipt protocol too large');
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short attempt receipt protocol write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    inspectExactReceiptAuthorityFile(path);
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
  }
}

function listAttemptReceiptAuthorityArtifacts(dir: string): Array<{
  name: string;
  generationId: string | null;
}> {
  const artifacts: Array<{ name: string; generationId: string | null }> = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_DIR_ENTRIES) {
        throw new Error('attempt receipt directory limit');
      }
      const receipt = ATTEMPT_RECEIPT_FILE_RE.exec(entry.name);
      const intent = ATTEMPT_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const failureReceipt = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(entry.name);
      const failureIntent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const generationId = receipt?.[1] ?? intent?.[1] ??
        failureReceipt?.[1] ?? failureIntent?.[1] ?? null;
      if (generationId !== null || entry.name === ATTEMPT_RECEIPT_RETENTION_FILE) {
        artifacts.push({ name: entry.name, generationId });
      }
    }
  } finally { handle.closeSync(); }
  return artifacts;
}

function assertNoAttemptReceiptAuthorityArtifacts(dir: string): void {
  if (listAttemptReceiptAuthorityArtifacts(dir).length > 0) {
    throw new Error('attempt receipt protocol missing with authority artifacts');
  }
}

function validateAttemptReceiptArtifactBindings(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
): void {
  const active = new Set(activation.generations.map((generation) => generation.generationId));
  const retention = readAttemptReceiptRetentionState();
  if (retention.present) {
    const validEpoch = !retention.epochBound
      ? retention.pendingGenerations.length > 0 && activation.retirementEpoch === 0
      : retention.pendingGenerations.length === 0
        ? retention.retirementEpoch === activation.retirementEpoch
        : retention.retirementEpoch === activation.retirementEpoch ||
          retention.retirementEpoch === activation.retirementEpoch + 1;
    if (!validEpoch) throw new Error('attempt receipt protocol rollback detected');
  } else if (activation.retirementEpoch !== 0) {
    throw new Error('attempt receipt retention anchor missing');
  }
  const pending = new Set(retention.pendingGenerations);
  for (const artifact of listAttemptReceiptAuthorityArtifacts(dir)) {
    if (artifact.generationId === null || active.has(artifact.generationId)) continue;
    if (!pending.has(artifact.generationId) ||
      !attemptGenerationMembershipHas(activation.blockedGenerations, artifact.generationId)) {
      throw new Error('attempt receipt protocol rollback detected');
    }
  }
}

export function ensureAttemptReceiptProtocolActivation(
  dir: string,
  event: DispatchProductionEvent,
): AttemptReceiptProtocolActivation {
  const existing = readAttemptReceiptProtocolActivation();
  if (existing !== null) {
    validateAttemptReceiptArtifactBindings(dir, existing);
    return existing;
  }
  assertNoAttemptReceiptAuthorityArtifacts(dir);
  const partitions = listAttemptProofPartitionDates(dispatchProductionDir(), dirname(dispatchProductionDir()));
  if (!partitions.ok) throw new Error(`attempt receipt activation ${partitions.reason}`);
  const blockedGenerations = readBoundedLegacyAttemptGenerationMembership(partitions.dates);
  if (!blockedGenerations.ok) throw new Error(`attempt receipt activation ${blockedGenerations.reason}`);
  const migratedSegment = membershipSegment(blockedGenerations.membership);
  const activatedAt = new Date().toISOString();
  const acceptsEventsAfter = new Date(Math.min(
    Date.parse(event.ts),
    Date.parse(activatedAt) - MAX_ATTEMPT_FUTURE_SKEW_MS,
  )).toISOString();
  const activation: AttemptReceiptProtocolActivation = {
    schemaVersion: 5,
    activationId: randomBytes(32).toString('hex'),
    activatedAt,
    acceptsEventsAfter,
    retirementEpoch: 0,
    generations: [],
    blockedGenerations: {
      ...emptyAttemptGenerationMembershipSet(),
      quality: membershipSegmentFalsePositiveRate(migratedSegment) >
        MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE ? 'saturated' : 'healthy',
      segments: [migratedSegment],
    },
  };
  writeAttemptReceiptProtocolActivation(dir, activation);
  return activation;
}

export function admitAttemptReceiptGeneration(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
  event: DispatchProductionEvent,
): AttemptReceiptProtocolActivation {
  const generationId = event.repairGenerationId!;
  const existing = activation.generations.find((generation) => generation.generationId === generationId);
  if (existing) return activation;
  if (membershipSetSaturated(activation.blockedGenerations)) {
    throw new AttemptMembershipSaturatedError(activation.blockedGenerations);
  }
  if (attemptGenerationMembershipHas(activation.blockedGenerations, generationId)) {
    throw new Error('attempt proof generation blocked');
  }
  if (activation.generations.length >= MAX_ATTEMPT_ACTIVE_GENERATIONS) {
    activation = reclaimArtifactlessAttemptGenerations(dir, activation);
    if (activation.generations.length >= MAX_ATTEMPT_ACTIVE_GENERATIONS) {
      throw new Error('attempt active generation capacity unavailable');
    }
  }
  if (Date.parse(event.ts) < Date.parse(activation.acceptsEventsAfter)) {
    throw new Error('attempt event predates protocol authority');
  }
  const next: AttemptReceiptProtocolActivation = {
    ...activation,
    generations: [...activation.generations, {
      generationId,
      admittedAt: event.ts,
    }].sort((left, right) => left.generationId.localeCompare(right.generationId)),
  };
  writeAttemptReceiptProtocolActivation(dir, next);
  return next;
}

function reclaimArtifactlessAttemptGenerations(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
): AttemptReceiptProtocolActivation {
  const artifactGenerations = new Set(listAttemptReceiptAuthorityArtifacts(dir)
    .map((artifact) => artifact.generationId)
    .filter((generationId): generationId is string => generationId !== null));
  const needed = Math.max(1, activation.generations.length - MAX_ATTEMPT_ACTIVE_GENERATIONS + 1);
  const reclaiming = activation.generations
    .filter((generation) => !artifactGenerations.has(generation.generationId))
    .sort((left, right) => Date.parse(left.admittedAt) - Date.parse(right.admittedAt) ||
      left.generationId.localeCompare(right.generationId))
    .slice(0, needed);
  if (reclaiming.length < needed) return activation;
  const blocked = addAttemptGenerationMembershipPersistingQuality(
    dir,
    activation,
    reclaiming.map((generation) => generation.generationId),
  );
  const reclaimingIds = new Set(reclaiming.map((generation) => generation.generationId));
  const next: AttemptReceiptProtocolActivation = {
    ...activation,
    generations: activation.generations.filter((generation) => !reclaimingIds.has(generation.generationId)),
    blockedGenerations: blocked,
  };
  // The atomic protocol replacement both retires the abandoned IDs and frees
  // their exact active slots. A crash can expose the old state or the new one,
  // never an admitted ID that was forgotten by both representations.
  writeAttemptReceiptProtocolActivation(dir, next);
  return next;
}

function validateAttemptRetentionArtifact(
  path: string,
  name: string,
  activationId: string,
  batchAssurance?: StableFileBatchAssurance,
): AttemptReceiptRetentionArtifact {
  const receipt = ATTEMPT_RECEIPT_FILE_RE.exec(name);
  const intent = ATTEMPT_RECEIPT_INTENT_FILE_RE.exec(name);
  const failureReceipt = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(name);
  const failureIntent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(name);
  const match = receipt ?? intent ?? failureReceipt ?? failureIntent;
  if (!match) throw new Error('invalid attempt receipt filename during retention');
  if (!batchAssurance) inspectExactReceiptAuthorityFile(path);
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_READ_ROW_BYTES,
    remainingBytes: MAX_READ_ROW_BYTES,
    ...(batchAssurance ? { batchAssurance } : {}),
  });
  if (!loaded.ok || !loaded.text.endsWith('\n') ||
    loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    throw new Error('invalid attempt receipt envelope during retention');
  }
  const receiptLine = loaded.text.slice(0, -1);
  let envelope: unknown;
  try { envelope = JSON.parse(receiptLine); } catch {
    throw new Error('invalid attempt receipt envelope during retention');
  }
  const failureArtifact = failureReceipt !== null || failureIntent !== null;
  if (!isPlainRecord(envelope) ||
    (envelope['receiptSchemaVersion'] !== 1 && envelope['receiptSchemaVersion'] !== 2) ||
    (envelope['receiptSchemaVersion'] === 2 && !failureArtifact) ||
    !hasOnlyKeys(envelope, envelope['receiptSchemaVersion'] === 2 ? new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'appendAuthority', 'event',
    ]) : new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'event',
    ])) ||
    envelope['validation'] !== ATTEMPT_RECEIPT_VALIDATION ||
    envelope['activationId'] !== activationId) {
    throw new Error('invalid attempt receipt activation during retention');
  }
  const event = envelope['event'];
  const canonicalLine = JSON.stringify(event);
  const canonicalRow = Buffer.from(`${canonicalLine}\n`, 'utf8');
  const ts = isPlainRecord(event) ? canonicalUtcTimestamp(event['ts']) : null;
  const appendAuthority = envelope['receiptSchemaVersion'] === 2 && isPlainRecord(event)
    ? parseAttemptFailureAppendAuthority(
        envelope['appendAuthority'], event as unknown as DispatchProductionEvent, canonicalRow,
      )
    : undefined;
  const canonicalEnvelope = envelope['receiptSchemaVersion'] === 2 && appendAuthority
    ? attemptFailureReceiptEnvelope(
        event as unknown as DispatchProductionEvent, activationId, appendAuthority,
      )
    : attemptReceiptEnvelope(event as DispatchProductionEvent, activationId);
  if (ts === null || !canonicalStoredDispatchProductionEvent(event, canonicalLine, ts.slice(0, 10)) ||
    (envelope['receiptSchemaVersion'] === 2 && !appendAuthority) ||
    receiptLine !== canonicalEnvelope) {
    throw new Error('invalid attempt receipt event during retention');
  }
  const authority = failureArtifact
    ? parseDispatchProductionFailureAttemptAuthority(event, canonicalLine)
    : parseDispatchProductionAttemptAuthority(event, canonicalLine);
  const generationId = match[1]!;
  const ordinal = Number(match[2]) as 1 | 2;
  if (authority === null || authority.proof.repairGenerationId !== generationId ||
    authority.proof.repairAttemptOrdinal !== ordinal ||
    (failureArtifact && authority.proof.attemptHash !== match[3]) ||
    authority.proof.eventDigest !== createHash('sha256').update(canonicalLine, 'utf8').digest('hex')) {
    throw new Error('unbound attempt receipt during retention');
  }
  return {
    name,
    generationId,
    ordinal,
    kind: receipt ? 'receipt'
      : intent ? 'intent'
        : failureReceipt ? 'failure-receipt'
          : 'failure-intent',
    eventTs: authority.event.ts,
    eventDigest: authority.proof.eventDigest,
    fileDigest: createHash('sha256').update(loaded.text, 'utf8').digest('hex'),
  };
}

function deleteAttemptReceiptArtifactsForGenerations(
  dir: string,
  generationIds: ReadonlySet<string>,
  activationId: string,
  expectedArtifacts: AttemptReceiptRetentionArtifacts,
): void {
  assertStableDispatchProductionWriteRoot();
  const dropping: AttemptReceiptRetentionArtifact[] = [];
  const expected = Array.isArray(expectedArtifacts)
    ? new Map(expectedArtifacts.map((artifact) => [artifact.name, artifact]))
    : null;
  const names: string[] = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_DIR_ENTRIES) {
        throw new Error('attempt receipt directory limit');
      }
      const receipt = ATTEMPT_RECEIPT_FILE_RE.exec(entry.name);
      const intent = ATTEMPT_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const failureReceipt = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(entry.name);
      const failureIntent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const generationId = receipt?.[1] ?? intent?.[1] ??
        failureReceipt?.[1] ?? failureIntent?.[1];
      if (!generationId || !generationIds.has(generationId)) continue;
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }

  for (let offset = 0; offset < names.length; offset += 512) {
    const batchNames = names.slice(offset, offset + 512);
    const paths = batchNames.map((name) => join(dir, name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe retired attempt receipt batch');
    for (let index = 0; index < batchNames.length; index++) {
      const artifact = validateAttemptRetentionArtifact(
        paths[index]!, batchNames[index]!, activationId, assurance.token,
      );
      const wanted = expected?.get(artifact.name);
      if (wanted && JSON.stringify(artifact) !== JSON.stringify(wanted)) {
        throw new Error('mutated attempt receipt during retention');
      }
      if (expected !== null && expected.size > 0 && !wanted) {
        throw new Error('unexpected attempt receipt during retention');
      }
      dropping.push(artifact);
    }
  }
  if (!Array.isArray(expectedArtifacts)) {
    const observed = attemptRetentionArtifactSet(dropping);
    const expectedDigests = new Set(expectedArtifacts.digests);
    if (observed.count > expectedArtifacts.count ||
      observed.digests.some((digest) => !expectedDigests.has(digest))) {
      throw new Error('mutated compact attempt receipt retention set');
    }
  }

  for (let offset = 0; offset < dropping.length; offset += 512) {
    const paths = dropping.slice(offset, offset + 512)
      .map((artifact) => join(dir, artifact.name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe retired attempt receipt batch');
    for (const path of paths) {
      if (!safeDispatchProductionFile(lstatSync(path))) {
        throw new Error('unsafe retired attempt receipt');
      }
    }
  }
  for (const artifact of dropping) {
    assertStableDispatchProductionWriteRoot();
    unlinkSync(join(dir, artifact.name));
  }
  if (dropping.length > 0) fsyncDirectory(dir);
  assertStableDispatchProductionWriteRoot();
}

export function recoverAttemptReceiptRetention(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
): AttemptReceiptProtocolActivation {
  const retention = readAttemptReceiptRetentionState();
  if (retention.pendingGenerations.length === 0) return activation;
  if (retention.droppedThrough === null) throw new Error('invalid pending attempt retention');
  const targetEpoch = retention.epochBound
    ? retention.retirementEpoch
    : activation.retirementEpoch === 0 ? 1 : activation.retirementEpoch;
  if (retention.epochBound && targetEpoch !== activation.retirementEpoch &&
    targetEpoch !== activation.retirementEpoch + 1) {
    throw new Error('invalid pending attempt retention epoch');
  }
  const pending = new Set(retention.pendingGenerations);
  const active = new Set(activation.generations.map((generation) => generation.generationId));
  for (const generationId of pending) {
    if (!active.has(generationId) &&
      !attemptGenerationMembershipHas(activation.blockedGenerations, generationId)) {
      throw new Error('invalid pending attempt retention');
    }
  }
  const next: AttemptReceiptProtocolActivation = {
    ...activation,
    retirementEpoch: targetEpoch,
    generations: activation.generations.filter((generation) => !pending.has(generation.generationId)),
    blockedGenerations: addAttemptGenerationMembershipPersistingQuality(dir, activation, pending),
  };
  if (next.generations.length !== activation.generations.length ||
    next.retirementEpoch !== activation.retirementEpoch) {
    writeAttemptReceiptProtocolActivation(dir, next);
  }
  deleteAttemptReceiptArtifactsForGenerations(
    dir, pending, activation.activationId, retention.pendingArtifacts,
  );
  writeAttemptReceiptRetention(
    dir, retention.droppedThrough, targetEpoch, [], [],
  );
  return next;
}

export function readAttemptReceiptRetentionState(): AttemptReceiptRetentionState {
  const path = join(attemptProofReceiptDir(), ATTEMPT_RECEIPT_RETENTION_FILE);
  if (!existsSync(path)) return {
    present: false,
    epochBound: false,
    droppedThrough: null,
    retirementEpoch: 0,
    pendingGenerations: [],
    pendingArtifacts: [],
  };
  inspectExactReceiptAuthorityDirectory(attemptProofReceiptDir());
  inspectExactReceiptAuthorityFile(path);
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_ATTEMPT_RECEIPT_RETENTION_BYTES,
    remainingBytes: MAX_ATTEMPT_RECEIPT_RETENTION_BYTES,
  });
  if (!loaded.ok) throw new Error('invalid attempt receipt retention marker');
  const parsed: unknown = JSON.parse(loaded.text);
  const retentionKeys = isPlainRecord(parsed) &&
    (parsed['schemaVersion'] === 4 || parsed['schemaVersion'] === 5 ||
      parsed['schemaVersion'] === 6)
    ? new Set([
      'schemaVersion', 'droppedThrough', 'retirementEpoch', 'pendingGenerations', 'pendingArtifacts',
    ])
    : isPlainRecord(parsed) && parsed['schemaVersion'] === 3
      ? new Set(['schemaVersion', 'droppedThrough', 'pendingGenerations', 'pendingArtifacts'])
      : new Set(['schemaVersion', 'droppedThrough', 'pendingGenerations']);
  if (!isPlainRecord(parsed) ||
    !hasOnlyKeys(parsed, retentionKeys) ||
    (parsed['schemaVersion'] !== 2 && parsed['schemaVersion'] !== 3 &&
      parsed['schemaVersion'] !== 4 && parsed['schemaVersion'] !== 5 &&
      parsed['schemaVersion'] !== 6) ||
    ((parsed['schemaVersion'] === 4 || parsed['schemaVersion'] === 5 ||
      parsed['schemaVersion'] === 6) &&
      (!Number.isSafeInteger(parsed['retirementEpoch']) || (parsed['retirementEpoch'] as number) < 0)) ||
    !Array.isArray(parsed['pendingGenerations']) ||
    parsed['pendingGenerations'].length > MAX_ATTEMPT_PROOF_RECEIPTS) {
    throw new Error('invalid attempt receipt retention marker');
  }
  const droppedThrough = parsed['droppedThrough'] === null
    ? null
    : canonicalUtcTimestamp(parsed['droppedThrough']);
  if (parsed['droppedThrough'] !== null && droppedThrough === null) {
    throw new Error('invalid attempt receipt retention marker');
  }
  const pendingGenerations: string[] = [];
  for (const generationId of parsed['pendingGenerations']) {
    if (typeof generationId !== 'string' || !SHA256_RE.test(generationId)) {
      throw new Error('invalid attempt receipt retention marker');
    }
    pendingGenerations.push(generationId);
  }
  if (pendingGenerations.some((generationId, index) =>
    index > 0 && pendingGenerations[index - 1]! >= generationId)) {
    throw new Error('invalid attempt receipt retention marker');
  }
  let pendingArtifacts: AttemptReceiptRetentionArtifacts = [];
  if (parsed['schemaVersion'] === 3 || parsed['schemaVersion'] === 4 ||
    parsed['schemaVersion'] === 5 || parsed['schemaVersion'] === 6) {
    const compact = parsed['schemaVersion'] === 6 && isPlainRecord(parsed['pendingArtifacts'])
      ? parsed['pendingArtifacts']
      : null;
    if (compact !== null) {
      if (!hasOnlyKeys(compact, new Set(['count', 'digests'])) ||
        !Number.isSafeInteger(compact['count']) || (compact['count'] as number) < 1 ||
        (compact['count'] as number) > MAX_ATTEMPT_PROOF_RECEIPTS ||
        !Array.isArray(compact['digests']) ||
        compact['digests'].length !== compact['count'] ||
        compact['digests'].some((digest) => typeof digest !== 'string' || !SHA256_RE.test(digest)) ||
        compact['digests'].some((digest, index, digests) =>
          index > 0 && String(digests[index - 1]) >= String(digest)) ||
        pendingGenerations.length === 0) {
        throw new Error('invalid attempt receipt retention marker');
      }
      pendingArtifacts = {
        count: compact['count'] as number,
        digests: compact['digests'] as string[],
      };
    } else if (!Array.isArray(parsed['pendingArtifacts']) ||
      parsed['pendingArtifacts'].length > MAX_ATTEMPT_PROOF_RECEIPTS * 2) {
      throw new Error('invalid attempt receipt retention marker');
    } else {
      const parsedArtifacts: AttemptReceiptRetentionArtifact[] = [];
      const seenArtifacts = new Set<string>();
      for (const value of parsed['pendingArtifacts']) {
        if (!isPlainRecord(value) || !hasOnlyKeys(value, new Set([
          'name', 'generationId', 'ordinal', 'kind', 'eventTs', 'eventDigest', 'fileDigest',
        ])) || typeof value['name'] !== 'string' ||
          typeof value['generationId'] !== 'string' || !SHA256_RE.test(value['generationId']) ||
          (value['ordinal'] !== 1 && value['ordinal'] !== 2) ||
          (value['kind'] !== 'receipt' && value['kind'] !== 'intent' &&
            ((parsed['schemaVersion'] !== 5 && parsed['schemaVersion'] !== 6) ||
              (value['kind'] !== 'failure-receipt' && value['kind'] !== 'failure-intent'))) ||
          canonicalUtcTimestamp(value['eventTs']) === null ||
          typeof value['eventDigest'] !== 'string' || !SHA256_RE.test(value['eventDigest']) ||
          typeof value['fileDigest'] !== 'string' || !SHA256_RE.test(value['fileDigest']) ||
          !pendingGenerations.includes(value['generationId']) || seenArtifacts.has(value['name'])) {
          throw new Error('invalid attempt receipt retention marker');
        }
        const expectedName = value['kind'] === 'receipt'
          ? attemptProofReceiptName(value['generationId'], value['ordinal'])
          : value['kind'] === 'intent'
            ? `${value['generationId']}-${value['ordinal']}.intent.json`
            : null;
        const failureMatch = value['kind'] === 'failure-receipt'
          ? ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(value['name'])
          : value['kind'] === 'failure-intent'
            ? ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(value['name'])
            : null;
        if (expectedName !== null ? value['name'] !== expectedName :
          failureMatch?.[1] !== value['generationId'] ||
            Number(failureMatch?.[2]) !== value['ordinal']) {
          throw new Error('invalid attempt receipt retention marker');
        }
        seenArtifacts.add(value['name']);
        parsedArtifacts.push(value as unknown as AttemptReceiptRetentionArtifact);
      }
      parsedArtifacts.sort((left, right) => left.name.localeCompare(right.name));
      pendingArtifacts = parsedArtifacts;
    }
  }
  return {
    present: true,
    epochBound: parsed['schemaVersion'] === 4 || parsed['schemaVersion'] === 5 ||
      parsed['schemaVersion'] === 6,
    droppedThrough,
    retirementEpoch: parsed['schemaVersion'] === 4 || parsed['schemaVersion'] === 5 ||
      parsed['schemaVersion'] === 6
      ? parsed['retirementEpoch'] as number
      : 0,
    pendingGenerations,
    pendingArtifacts,
  };
}

function writeAttemptReceiptRetention(
  dir: string,
  droppedThrough: string,
  retirementEpoch: number,
  pendingGenerations: readonly string[],
  pendingArtifacts: readonly AttemptReceiptRetentionArtifact[],
): void {
  assertStableDispatchProductionWriteRoot();
  const path = join(dir, ATTEMPT_RECEIPT_RETENTION_FILE);
  const tmp = attemptReceiptStagePath(path);
  const prior = readAttemptReceiptRetentionState();
  if (!Number.isSafeInteger(retirementEpoch) || retirementEpoch < prior.retirementEpoch) {
    throw new Error('invalid attempt receipt retention epoch');
  }
  const priorMs = prior.droppedThrough === null
    ? Number.NEGATIVE_INFINITY
    : Date.parse(prior.droppedThrough);
  const nextMs = Math.max(priorMs, Date.parse(droppedThrough));
  if (!Number.isFinite(nextMs)) throw new Error('invalid attempt receipt retention timestamp');
  const pending = [...new Set(pendingGenerations)].sort();
  if (pending.length > MAX_ATTEMPT_PROOF_RECEIPTS || pending.some((generationId) => !SHA256_RE.test(generationId))) {
    throw new Error('invalid pending attempt retention');
  }
  const sortedArtifacts = [...pendingArtifacts]
    .sort((left, right) => left.name.localeCompare(right.name));
  const marker = {
    schemaVersion: 5,
    droppedThrough: new Date(nextMs).toISOString(),
    retirementEpoch,
    pendingGenerations: pending,
    pendingArtifacts: sortedArtifacts,
  };
  let bytes = Buffer.from(`${JSON.stringify(marker)}\n`);
  if (bytes.length > MAX_ATTEMPT_RECEIPT_RETENTION_BYTES && sortedArtifacts.length > 0) {
    bytes = Buffer.from(`${JSON.stringify({
      ...marker,
      schemaVersion: 6,
      pendingArtifacts: attemptRetentionArtifactSet(sortedArtifacts),
    })}\n`);
  }
  if (bytes.length > MAX_ATTEMPT_RECEIPT_RETENTION_BYTES) {
    throw new Error('attempt receipt retention marker too large');
  }
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short attempt receipt retention write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    inspectExactReceiptAuthorityFile(path);
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
  }
}

interface AttemptReceiptRetentionPlan {
  dropping: Array<AttemptReceiptRetentionArtifact & { ts: string }>;
  droppedThrough: string;
}

function failureAttemptRetentionKey(
  generationId: string,
  ordinal: 1 | 2,
  attemptHash: string,
): string {
  return JSON.stringify([generationId, ordinal, attemptHash]);
}

function failureAttemptRetentionArtifactKey(artifact: AttemptReceiptRetentionArtifact): string | null {
  const match = artifact.kind === 'failure-receipt'
    ? ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(artifact.name)
    : artifact.kind === 'failure-intent'
      ? ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(artifact.name)
      : null;
  return match === null
    ? null
    : failureAttemptRetentionKey(match[1]!, Number(match[2]) as 1 | 2, match[3]!);
}

function failureAttemptRetentionRawDigests(
  text: string,
  wanted: ReadonlySet<string>,
): Map<string, Set<string>> {
  const matches = new Map<string, Set<string>>();
  for (const line of text.slice(0, -1).split('\n')) {
    const event: unknown = JSON.parse(line);
    const authority = isPlainRecord(event)
      ? parseDispatchProductionFailureAttemptAuthority(event as unknown as DispatchProductionEvent, line)
      : null;
    if (authority === null) continue;
    const key = failureAttemptRetentionKey(
      authority.proof.repairGenerationId,
      authority.proof.repairAttemptOrdinal,
      authority.proof.attemptHash,
    );
    if (!wanted.has(key)) continue;
    const digests = matches.get(key) ?? new Set<string>();
    digests.add(authority.proof.eventDigest);
    matches.set(key, digests);
  }
  return matches;
}

function validateAttemptRetentionRawBindings(
  artifacts: readonly AttemptReceiptRetentionArtifact[],
): void {
  const byDate = new Map<string, AttemptReceiptRetentionArtifact[]>();
  for (const artifact of artifacts) {
    const date = artifact.eventTs.slice(0, 10);
    const entries = byDate.get(date) ?? [];
    entries.push(artifact);
    byDate.set(date, entries);
  }
  if (byDate.size > HARD_READ_MAX_FILES) throw new Error('attempt retention date limit');
  let remainingBytes = HARD_READ_MAX_BYTES;
  let remainingRows = HARD_READ_MAX_ROWS;
  for (const [date, entries] of byDate) {
    const path = join(dispatchProductionDir(), `${date}.jsonl`);
    if (!existsSync(path)) {
      if (entries.some((entry) => entry.kind === 'receipt' || entry.kind === 'failure-receipt')) {
        throw new Error('attempt receipt raw partition missing during retention');
      }
      continue;
    }
    const loaded = readStableRegularFile(path, {
      anchorPath: dirname(dispatchProductionDir()),
      maxFileBytes: HARD_READ_MAX_BYTES,
      remainingBytes,
    });
    if (!loaded.ok) throw new Error('attempt receipt raw partition unavailable during retention');
    remainingBytes -= loaded.bytesRead;
    const wanted = new Set(entries.map((entry) => entry.generationId));
    const parsed = parseAttemptProofPartition(
      loaded.text, loaded.bytesRead, date, remainingRows, new Set(), wanted,
    );
    if (!parsed.ok) throw new Error('attempt receipt raw partition invalid during retention');
    remainingRows -= parsed.rowsRead;
    const failureArtifacts = entries.filter((artifact) =>
      artifact.kind === 'failure-receipt' || artifact.kind === 'failure-intent');
    const failureKeys = new Set(failureArtifacts.map(failureAttemptRetentionArtifactKey)
      .filter((key): key is string => key !== null));
    const failureMatches = failureAttemptRetentionRawDigests(loaded.text, failureKeys);
    for (const artifact of entries) {
      const failureKey = failureAttemptRetentionArtifactKey(artifact);
      if (failureKey !== null) {
        const digests = failureMatches.get(failureKey) ?? new Set<string>();
        if (digests.size === 0) {
          if (artifact.kind === 'failure-receipt') {
            throw new Error('attempt failure receipt raw event missing during retention');
          }
          continue;
        }
        if (digests.size !== 1 || !digests.has(artifact.eventDigest)) {
          throw new Error('attempt failure receipt raw digest conflict during retention');
        }
        continue;
      }
      const sameOrdinal = [...new Map((parsed.sequenceMatches.get(artifact.generationId) ?? [])
        .filter((match) => match.ordinal === artifact.ordinal)
        .map((match) => [match.eventDigest, match])).values()];
      if (sameOrdinal.length === 0) {
        if (artifact.kind === 'receipt') throw new Error('attempt receipt raw event missing during retention');
        continue;
      }
      if (sameOrdinal.length !== 1 || sameOrdinal[0]!.row === null ||
        sameOrdinal[0]!.eventDigest !== artifact.eventDigest) {
        throw new Error('attempt receipt raw digest conflict during retention');
      }
    }
  }
}

export function planAttemptProofReceiptRetention(
  dir: string,
  preservedGenerationId: string,
  activation: AttemptReceiptProtocolActivation,
): AttemptReceiptRetentionPlan | null {
  const receipts: Array<AttemptReceiptRetentionArtifact & { ts: string }> = [];
  const generations = new Map(activation.generations.map((generation) => [generation.generationId, generation]));
  const names: string[] = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_DIR_ENTRIES) {
        throw new Error('attempt receipt directory limit');
      }
      const receipt = ATTEMPT_RECEIPT_FILE_RE.exec(entry.name);
      const intent = ATTEMPT_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const failureReceipt = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(entry.name);
      const failureIntent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const match = receipt ?? intent ?? failureReceipt ?? failureIntent;
      if (!match) continue;
      const generation = generations.get(match[1]!);
      if (!generation) throw new Error('unbound attempt receipt during retention');
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  for (let offset = 0; offset < names.length; offset += 512) {
    const batchNames = names.slice(offset, offset + 512);
    const paths = batchNames.map((name) => join(dir, name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe attempt receipt retention batch');
    for (let index = 0; index < batchNames.length; index++) {
      const artifact = validateAttemptRetentionArtifact(
        paths[index]!, batchNames[index]!, activation.activationId, assurance.token,
      );
      const generation = generations.get(artifact.generationId);
      if (!generation) throw new Error('unbound attempt receipt during retention');
      receipts.push({ ...artifact, ts: generation.admittedAt });
    }
  }
  validateAttemptRetentionRawBindings(receipts);
  if (receipts.length < MAX_ATTEMPT_PROOF_RECEIPTS) return null;

  const byGeneration = new Map<string, Array<AttemptReceiptRetentionArtifact & { ts: string }>>();
  for (const receipt of receipts) {
    const group = byGeneration.get(receipt.generationId) ?? [];
    group.push(receipt);
    byGeneration.set(receipt.generationId, group);
  }
  const groups = [...byGeneration.values()]
    .filter((group) => group[0]!.generationId !== preservedGenerationId)
    .sort((left, right) => {
    const leftTs = Math.max(...left.map((receipt) => Date.parse(receipt.ts)));
    const rightTs = Math.max(...right.map((receipt) => Date.parse(receipt.ts)));
    return leftTs - rightTs || left[0]!.generationId.localeCompare(right[0]!.generationId);
    });
  const dropping: Array<AttemptReceiptRetentionArtifact & { ts: string }> = [];
  let remaining = receipts.length;
  for (const group of groups) {
    if (remaining < MAX_ATTEMPT_PROOF_RECEIPTS) break;
    dropping.push(...group);
    remaining -= group.length;
  }
  if (dropping.length === 0) throw new Error('attempt receipt capacity unavailable');
  const droppedThrough = dropping.reduce((latest, receipt) =>
    Date.parse(receipt.eventTs) > Date.parse(latest) ? receipt.eventTs : latest, dropping[0]!.eventTs);
  return { dropping, droppedThrough };
}

export function applyAttemptReceiptRetention(
  dir: string,
  plan: AttemptReceiptRetentionPlan,
  activation: AttemptReceiptProtocolActivation,
): AttemptReceiptProtocolActivation {
  if (activation.retirementEpoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error('attempt receipt retirement epoch exhausted');
  }
  const dropping = new Set(plan.dropping.map((receipt) => receipt.generationId));
  const pendingArtifacts = plan.dropping.map(({ ts: _ts, ...artifact }) => artifact);
  const next: AttemptReceiptProtocolActivation = {
    ...activation,
    retirementEpoch: activation.retirementEpoch + 1,
    generations: activation.generations.filter((generation) => !dropping.has(generation.generationId)),
    blockedGenerations: addAttemptGenerationMembershipPersistingQuality(dir, activation, dropping),
  };
  writeAttemptReceiptRetention(
    dir, plan.droppedThrough, next.retirementEpoch, [...dropping], pendingArtifacts,
  );
  dispatchProductionLedgerRetentionHooksForTest?.afterAttemptRetentionMarker?.();
  writeAttemptReceiptProtocolActivation(dir, next);
  deleteAttemptReceiptArtifactsForGenerations(
    dir, dropping, activation.activationId, pendingArtifacts,
  );
  writeAttemptReceiptRetention(dir, plan.droppedThrough, next.retirementEpoch, [], []);
  return next;
}
