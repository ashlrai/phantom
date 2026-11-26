import { createHmac, randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import {
  operationalProposalProjectionDir,
} from './operational-projection.js';
import {
  SHA256_RE as DIGEST_RE,
  canonicalTimestamp,
  equalDigest,
  hmacDomainPayload,
  loadDerivedDomainKey,
  safePrivateDirectory,
  validProposalId,
} from './operational-projection-helpers.js';
import {
  ownsProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from './proposal-mutation-lock.js';

const SCHEMA_VERSION = 1 as const;
const MAX_TRANSACTION_BYTES = 64 * 1024;
const KEY_DOMAIN = 'ashlr.operational-projection-transaction.key.v1';
const KEY_ID_DOMAIN = 'ashlr.operational-projection-transaction.key-id.v1';
const ATTESTATION_DOMAIN = 'ashlr.operational-projection-transaction.record.v1';

export type OperationalProjectionTransactionPhase =
  | 'prepared'
  | 'proposal-installed'
  | 'projection-installed'
  | 'committed';

export interface OperationalProjectionTransactionDigestsV1 {
  proposal: string | null;
  projection: string | null;
}

export interface OperationalProjectionTransactionV1 {
  schemaVersion: 1;
  transactionId: string;
  signingKeyId: string;
  proposalId: string;
  phase: OperationalProjectionTransactionPhase;
  before: OperationalProjectionTransactionDigestsV1;
  after: OperationalProjectionTransactionDigestsV1;
  createdAt: string;
  updatedAt: string;
  attestation: string;
}

export type OperationalProjectionTransactionReadResult =
  | { state: 'missing'; transaction: null }
  | { state: 'healthy'; transaction: OperationalProjectionTransactionV1 }
  | { state: 'degraded'; reason: string; transaction: null };

export type OperationalProjectionRecoveryState =
  | 'no-effect'
  | 'proposal-only'
  | 'projection-only'
  | 'complete'
  | 'unknown';

export interface PrepareOperationalProjectionTransactionInput {
  proposalId: string;
  before: OperationalProjectionTransactionDigestsV1;
  after: OperationalProjectionTransactionDigestsV1;
  storeLock: ProposalStoreMutationLock;
  now?: Date;
}

export const OPERATIONAL_PROJECTION_PHASE_ORDER: Record<OperationalProjectionTransactionPhase, number> = {
  prepared: 0,
  'proposal-installed': 1,
  'projection-installed': 2,
  committed: 3,
};
const PHASE_ORDER = OPERATIONAL_PROJECTION_PHASE_ORDER;

function validDigest(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && DIGEST_RE.test(value));
}

export function validDigestPair(value: unknown): value is OperationalProjectionTransactionDigestsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'projection,proposal' &&
    validDigest(record['proposal']) && validDigest(record['projection']);
}

export function validPhase(value: unknown): value is OperationalProjectionTransactionPhase {
  return typeof value === 'string' && Object.hasOwn(PHASE_ORDER, value);
}

function canonicalRecord(value: Omit<OperationalProjectionTransactionV1, 'attestation'>): string {
  return JSON.stringify({
    after: { projection: value.after.projection, proposal: value.after.proposal },
    before: { projection: value.before.projection, proposal: value.before.proposal },
    createdAt: value.createdAt,
    phase: value.phase,
    proposalId: value.proposalId,
    schemaVersion: value.schemaVersion,
    signingKeyId: value.signingKeyId,
    transactionId: value.transactionId,
    updatedAt: value.updatedAt,
  });
}

function attest(
  key: Buffer,
  value: Omit<OperationalProjectionTransactionV1, 'attestation'>,
): string {
  return hmacDomainPayload(key, ATTESTATION_DOMAIN, canonicalRecord(value));
}

function parseRecord(text: string): OperationalProjectionTransactionV1 | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !==
      'after,attestation,before,createdAt,phase,proposalId,schemaVersion,signingKeyId,transactionId,updatedAt') return null;
    if (value['schemaVersion'] !== SCHEMA_VERSION ||
      typeof value['transactionId'] !== 'string' || !DIGEST_RE.test(value['transactionId']) ||
      typeof value['signingKeyId'] !== 'string' || !DIGEST_RE.test(value['signingKeyId']) ||
      !validProposalId(value['proposalId']) || !validPhase(value['phase']) ||
      !validDigestPair(value['before']) || !validDigestPair(value['after']) ||
      !canonicalTimestamp(value['createdAt']) || !canonicalTimestamp(value['updatedAt']) ||
      Date.parse(value['updatedAt']) < Date.parse(value['createdAt']) ||
      typeof value['attestation'] !== 'string' || !DIGEST_RE.test(value['attestation'])) return null;
    return value as unknown as OperationalProjectionTransactionV1;
  } catch {
    return null;
  }
}

function loadKey(): { key: Buffer; id: string } | null {
  return loadDerivedDomainKey(KEY_DOMAIN, KEY_ID_DOMAIN);
}

function safeDirectory(): boolean {
  return safePrivateDirectory(operationalProposalProjectionDir());
}

export function operationalProjectionTransactionPath(): string {
  return join(operationalProposalProjectionDir(), 'active-transaction.json');
}

export function readOperationalProjectionTransaction(): OperationalProjectionTransactionReadResult {
  const path = operationalProjectionTransactionPath();
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { state: 'degraded', reason: 'transaction-unavailable', transaction: null };
    }
    try {
      lstatSync(operationalProposalProjectionDir());
    } catch (directoryError) {
      return (directoryError as NodeJS.ErrnoException).code === 'ENOENT'
        ? { state: 'missing', transaction: null }
        : { state: 'degraded', reason: 'transaction-directory-unsafe', transaction: null };
    }
    return safeDirectory()
      ? { state: 'missing', transaction: null }
      : { state: 'degraded', reason: 'transaction-directory-unsafe', transaction: null };
  }
  if (!safeDirectory()) {
    return { state: 'degraded', reason: 'transaction-directory-unsafe', transaction: null };
  }
  const read = readStableRegularFile(path, {
    anchorPath: homedir(),
    maxFileBytes: MAX_TRANSACTION_BYTES,
    remainingBytes: MAX_TRANSACTION_BYTES,
  });
  if (!read.ok) return { state: 'degraded', reason: read.reason, transaction: null };
  const transaction = parseRecord(read.text);
  if (!transaction) return { state: 'degraded', reason: 'transaction-invalid', transaction: null };
  const signing = loadKey();
  if (!signing) return { state: 'degraded', reason: 'transaction-key-unavailable', transaction: null };
  if (!equalDigest(transaction.signingKeyId, signing.id)) {
    return { state: 'degraded', reason: 'transaction-key-generation-mismatch', transaction: null };
  }
  const { attestation, ...unsigned } = transaction;
  if (!equalDigest(attest(signing.key, unsigned), attestation)) {
    return { state: 'degraded', reason: 'transaction-integrity-failed', transaction: null };
  }
  return { state: 'healthy', transaction };
}

function writeRecord(
  transaction: OperationalProjectionTransactionV1,
  storeLock: ProposalStoreMutationLock,
): boolean {
  if (!ownsProposalStoreMutationLock(storeLock) || !safeDirectory()) return false;
  const json = `${JSON.stringify(transaction)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_TRANSACTION_BYTES) return false;
  try {
    const temporaryPath = join(
      operationalProposalProjectionDir(),
      `.active-transaction.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
    );
    writePrivateFileAtomically(temporaryPath, operationalProjectionTransactionPath(), json, {
      anchorPath: operationalProposalProjectionDir(),
      label: 'operational projection transaction',
    });
    if (!ownsProposalStoreMutationLock(storeLock)) return false;
    const reread = readOperationalProjectionTransaction();
    return ownsProposalStoreMutationLock(storeLock) && reread.state === 'healthy' &&
      reread.transaction.transactionId === transaction.transactionId &&
      reread.transaction.phase === transaction.phase &&
      equalDigest(reread.transaction.attestation, transaction.attestation);
  } catch {
    return false;
  }
}

export function prepareOperationalProjectionTransactionJournalOnly(
  input: PrepareOperationalProjectionTransactionInput,
): OperationalProjectionTransactionReadResult {
  if (!ownsProposalStoreMutationLock(input.storeLock) || !validProposalId(input.proposalId) ||
    !validDigestPair(input.before) || !validDigestPair(input.after) ||
    input.before.proposal === input.after.proposal ||
    input.before.projection === input.after.projection) {
    return { state: 'degraded', reason: 'transaction-input-invalid', transaction: null };
  }
  const current = readOperationalProjectionTransaction();
  if (current.state === 'degraded') return current;
  if (current.state === 'healthy' && current.transaction.phase !== 'committed') {
    return { state: 'degraded', reason: 'transaction-already-active', transaction: null };
  }
  const signing = loadKey();
  const now = input.now ?? new Date();
  if (!signing || !Number.isFinite(now.getTime())) {
    return { state: 'degraded', reason: 'transaction-key-unavailable', transaction: null };
  }
  if (current.state === 'healthy' &&
    now.getTime() < Date.parse(current.transaction.updatedAt)) {
    return { state: 'degraded', reason: 'transaction-input-invalid', transaction: null };
  }
  const timestamp = now.toISOString();
  const transactionId = createHmac('sha256', signing.key)
    .update('ashlr.operational-projection-transaction.id.v1\n', 'utf8')
    .update(input.proposalId, 'utf8')
    .update('\n', 'utf8')
    .update(timestamp, 'utf8')
    .update('\n', 'utf8')
    .update(randomBytes(16))
    .digest('hex');
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    transactionId,
    signingKeyId: signing.id,
    proposalId: input.proposalId,
    phase: 'prepared' as const,
    before: input.before,
    after: input.after,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const transaction = { ...unsigned, attestation: attest(signing.key, unsigned) };
  return writeRecord(transaction, input.storeLock)
    ? { state: 'healthy', transaction }
    : { state: 'degraded', reason: 'transaction-write-failed', transaction: null };
}

export function advanceOperationalProjectionTransactionJournalOnly(
  transactionId: string,
  phase: OperationalProjectionTransactionPhase,
  storeLock: ProposalStoreMutationLock,
  now = new Date(),
): OperationalProjectionTransactionReadResult {
  if (!DIGEST_RE.test(transactionId) || !validPhase(phase) ||
    !ownsProposalStoreMutationLock(storeLock) || !Number.isFinite(now.getTime())) {
    return { state: 'degraded', reason: 'transaction-input-invalid', transaction: null };
  }
  const current = readOperationalProjectionTransaction();
  if (current.state !== 'healthy') return current;
  if (current.transaction.transactionId !== transactionId) {
    return { state: 'degraded', reason: 'transaction-identity-mismatch', transaction: null };
  }
  const currentOrder = PHASE_ORDER[current.transaction.phase];
  const nextOrder = PHASE_ORDER[phase];
  if (nextOrder < currentOrder || nextOrder > currentOrder + 1 ||
    now.getTime() < Date.parse(current.transaction.updatedAt)) {
    return { state: 'degraded', reason: 'transaction-phase-invalid', transaction: null };
  }
  if (nextOrder === currentOrder) return current;
  const signing = loadKey();
  if (!signing) return { state: 'degraded', reason: 'transaction-key-unavailable', transaction: null };
  if (!equalDigest(current.transaction.signingKeyId, signing.id)) {
    return { state: 'degraded', reason: 'transaction-key-generation-mismatch', transaction: null };
  }
  const { attestation: _attestation, ...prior } = current.transaction;
  const unsigned = { ...prior, phase, updatedAt: now.toISOString() };
  const transaction = { ...unsigned, attestation: attest(signing.key, unsigned) };
  return writeRecord(transaction, storeLock)
    ? { state: 'healthy', transaction }
    : { state: 'degraded', reason: 'transaction-write-failed', transaction: null };
}

export function classifyOperationalProjectionRecovery(
  transaction: Pick<OperationalProjectionTransactionV1, 'before' | 'after'>,
  actual: OperationalProjectionTransactionDigestsV1,
): OperationalProjectionRecoveryState {
  if (!validDigestPair(transaction.before) || !validDigestPair(transaction.after) ||
    !validDigestPair(actual) ||
    transaction.before.proposal === transaction.after.proposal ||
    transaction.before.projection === transaction.after.projection) return 'unknown';
  const proposalBefore = actual.proposal === transaction.before.proposal;
  const proposalAfter = actual.proposal === transaction.after.proposal;
  const projectionBefore = actual.projection === transaction.before.projection;
  const projectionAfter = actual.projection === transaction.after.projection;
  if (proposalBefore && projectionBefore) return 'no-effect';
  if (proposalAfter && projectionBefore) return 'proposal-only';
  if (proposalBefore && projectionAfter) return 'projection-only';
  if (proposalAfter && projectionAfter) return 'complete';
  return 'unknown';
}
