/** Append-only ledger and attempt receipt writes. */

import type { DispatchProductionEvent, DispatchProductionWriteResult } from './types.js';
import { tokenEnvelopeCurrent } from '../../run/token-evidence.js';
import {
  materializeDispatchProductionAttemptEnvelope,
  sanitizeDispatchProductionEvent,
  isDispatchProductionEvent,
  eventDateString,
} from './events.js';
import {
  parseDispatchProductionAttemptAuthority,
  parseDispatchProductionFailureAttemptAuthority,
  isPlainRecord,
  hasOnlyKeys,
  sameBigIntSnapshot,
  readAttemptProofReceipt,
  readAttemptProofReceiptFile,
} from './attempt-proofs.js';
import {
  MAX_ATTEMPT_FUTURE_SKEW_MS,
  MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES,
  ATTEMPT_RECEIPT_STAGE_FILE_RE,
  MAX_STALE_ATTEMPT_RECEIPT_STAGES,
  ATTEMPT_RECEIPT_VALIDATION,
  MAX_READ_ROW_BYTES,
  ATTEMPT_RECEIPT_FILE_RE,
  ATTEMPT_RECEIPT_INTENT_FILE_RE,
  ATTEMPT_FAILURE_RECEIPT_FILE_RE,
  ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE,
  MAX_ATTEMPT_PROOF_RECEIPTS,
  MAX_ATTEMPT_FAILURE_RECEIPT_BYTES,
} from './constants.js';
import {
  withStableDispatchProductionWriteRoot,
  dispatchProductionDir,
  treatmentOutcomeReceiptName,
  appendDispatchProductionLine,
  withDispatchProductionGenerationAuthority,
  assertStableDispatchProductionWriteRoot,
  safeDispatchProductionFile,
  attemptProofReceiptDir,
  ensurePrivateReceiptDirectory,
  attemptReceiptLockPath,
  attemptProofReceiptName,
  inspectExactReceiptAuthorityFile,
  secureCreatedReceiptTempFile,
  attemptFailureReceiptName,
  sameFile,
} from './storage.js';
import { persistTreatmentOutcomeReceipt } from './treatment-receipts.js';
import { join, dirname } from 'node:path';
import {
  AttemptMembershipSaturatedError,
  readDispatchProductionAttemptProtocolQuality,
  ensureAttemptReceiptProtocolActivation,
  recoverAttemptReceiptRetention,
  admitAttemptReceiptGeneration,
  planAttemptProofReceiptRetention,
  applyAttemptReceiptRetention,
} from './attempt-retention.js';
import { randomBytes, createHash } from 'node:crypto';
import {
  lstatSync,
  unlinkSync,
  opendirSync,
  type BigIntStats,
  fstatSync,
  readSync,
  existsSync,
  renameSync,
  openSync,
  constants as fsConstants,
  writeSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { assurePrivateStoragePath } from '../../util/private-storage.js';
import { fsyncDirectory } from '../../util/durability.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../local-store-lock.js';
import { dispatchProductionLedgerRetentionHooksForTest } from './retention-hooks.js';
import { readFailureAttemptReceiptFile } from './attempt-resolution.js';

export function recordDispatchProduction(
  input: DispatchProductionEvent | DispatchProductionEvent[],
): DispatchProductionWriteResult {
  const result: DispatchProductionWriteResult = { attempted: 0, recorded: 0, failed: 0 };
  try {
    const events = Array.isArray(input) ? input : [input];
    result.attempted = events.length;
    if (events.length === 0) return result;
    for (const event of events) {
      try {
        if (!tokenEnvelopeCurrent(event as unknown as Record<string, unknown>, false)) throw new Error('invalid token provenance envelope');
        const lifecycle = event.basis === 'repair-lifecycle-candidate' ||
          event.basis === 'repair-lifecycle-outcome';
        const writeEvent = lifecycle ? event : materializeDispatchProductionAttemptEnvelope(event);
        const record = sanitizeDispatchProductionEvent(writeEvent, { materializeLearningLabel: true });
        if (!isDispatchProductionEvent(record)) throw new Error('dispatch production repository identity is not canonical');
        const canonicalLine = JSON.stringify(record);
        const attemptAuthority = parseDispatchProductionAttemptAuthority(record, canonicalLine);
        const failureAuthority = parseDispatchProductionFailureAttemptAuthority(record, canonicalLine);
        if (
          (attemptAuthority !== null || failureAuthority !== null) &&
          Date.parse(record.ts) > Date.now() + MAX_ATTEMPT_FUTURE_SKEW_MS
        ) throw new Error('future-dated generated repair attempt');
        withStableDispatchProductionWriteRoot(() => {
          const dir = dispatchProductionDir();
          const write = (): void => {
            const receiptName = treatmentOutcomeReceiptName(record);
            if (receiptName) persistTreatmentOutcomeReceipt(record, receiptName);
            else {
              const append = (): void => appendDispatchProductionLine(
                join(dir, `${eventDateString(record.ts)}.jsonl`), canonicalLine + '\n',
              );
              if (attemptAuthority !== null) {
                recordAttemptProductionWithReceipt(record, canonicalLine, append);
              } else if (failureAuthority !== null) {
                recordFailureAttemptProductionWithReceipt(record, canonicalLine);
              } else append();
            }
          };
          if (record.repairGenerationId && record.repairAttemptOrdinal) {
            if (!withDispatchProductionGenerationAuthority(record.repairGenerationId, write).ok) {
              throw new Error('dispatch production generation authority unavailable');
            }
          } else write();
        });
        result.recorded += 1;
      } catch (error) {
        // Skip only this record; later records in the batch still get a chance.
        result.failed += 1;
        let membershipSaturated = error instanceof AttemptMembershipSaturatedError;
        if (!membershipSaturated) {
          try {
            membershipSaturated = readDispatchProductionAttemptProtocolQuality().status === 'saturated';
          } catch {
            // Preserve the original fail-closed write result when quality cannot be read.
          }
        }
        if (membershipSaturated) {
          result.failureReasons = [...new Set([
            ...(result.failureReasons ?? []), 'retirement-membership-saturated' as const,
          ])];
        }
      }
    }
  } catch {
    // Telemetry/history must never fail dispatch.
    result.failed = Math.max(result.failed, result.attempted - result.recorded);
  }
  return result;
}

export function attemptReceiptStagePath(path: string): string {
  return `${path}.${randomBytes(16).toString('hex')}.stage`;
}

export function cleanupDispatchProductionWriteTemp(path: string): void {
  try {
    assertStableDispatchProductionWriteRoot();
    const stat = lstatSync(path);
    if (safeDispatchProductionFile(stat)) unlinkSync(path);
  } catch {
    // A missing, replaced, linked, or out-of-root temp is never followed or removed.
  }
}

export function attemptReceiptIntentPath(generationId: string, ordinal: 1 | 2): string {
  return join(attemptProofReceiptDir(), `${generationId}-${ordinal}.intent.json`);
}

export function attemptFailureReceiptIntentPath(
  generationId: string,
  ordinal: 1 | 2,
  attemptHash: string,
): string {
  return join(
    attemptProofReceiptDir(),
    `${generationId}-${ordinal}-${attemptHash}.failure.intent.json`,
  );
}

function cleanupStaleAttemptReceiptStages(dir: string): void {
  assertStableDispatchProductionWriteRoot();
  const stale: string[] = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES) {
        throw new Error('attempt receipt directory scan limit');
      }
      if (!ATTEMPT_RECEIPT_STAGE_FILE_RE.test(entry.name)) continue;
      stale.push(entry.name);
      if (stale.length > MAX_STALE_ATTEMPT_RECEIPT_STAGES) {
        throw new Error('attempt receipt staging limit');
      }
    }
  } finally { handle.closeSync(); }

  for (const name of stale) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (!safeDispatchProductionFile(stat) ||
      (process.platform === 'win32' && !assurePrivateStoragePath(
        path, 'file', 'inspect-owned', { anchorPath: dispatchProductionDir() },
      ).ok)) {
      throw new Error('unsafe attempt receipt stage');
    }
  }
  for (const name of stale) {
    assertStableDispatchProductionWriteRoot();
    unlinkSync(join(dir, name));
  }
  if (stale.length > 0) fsyncDirectory(dir);
  assertStableDispatchProductionWriteRoot();
}

export function attemptReceiptEnvelope(event: DispatchProductionEvent, activationId: string): string {
  return JSON.stringify({
    receiptSchemaVersion: 1,
    validation: ATTEMPT_RECEIPT_VALIDATION,
    activationId,
    event,
  });
}

export interface AttemptFailureAppendAuthority {
  schemaVersion: 1;
  partitionDate: string;
  appendOffset: number;
  appendBytes: number;
  appendDigest: string;
  fileIdentity: {
    device: string;
    inode: string;
    size: number;
    mtimeNs: string;
    ctimeNs: string;
  };
}

export function attemptFailureReceiptEnvelope(
  event: DispatchProductionEvent,
  activationId: string,
  appendAuthority: AttemptFailureAppendAuthority,
): string {
  return JSON.stringify({
    receiptSchemaVersion: 2,
    validation: ATTEMPT_RECEIPT_VALIDATION,
    activationId,
    appendAuthority,
    event,
  });
}

function safeBigIntDispatchProductionFile(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function attemptFailureAppendAuthority(
  event: DispatchProductionEvent,
  canonicalRow: Buffer,
  stat: BigIntStats,
): AttemptFailureAppendAuthority {
  const size = Number(stat.size);
  if (!safeBigIntDispatchProductionFile(stat) || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('attempt failure partition size unavailable');
  }
  return {
    schemaVersion: 1,
    partitionDate: eventDateString(event.ts),
    appendOffset: size,
    appendBytes: canonicalRow.length,
    appendDigest: createHash('sha256').update(canonicalRow).digest('hex'),
    fileIdentity: {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size,
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    },
  };
}

export function parseAttemptFailureAppendAuthority(
  value: unknown,
  event: DispatchProductionEvent,
  canonicalRow: Buffer,
): AttemptFailureAppendAuthority | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, new Set([
    'schemaVersion', 'partitionDate', 'appendOffset', 'appendBytes',
    'appendDigest', 'fileIdentity',
  ])) || value['schemaVersion'] !== 1 ||
    value['partitionDate'] !== eventDateString(event.ts) ||
    !Number.isSafeInteger(value['appendOffset']) || (value['appendOffset'] as number) < 0 ||
    value['appendBytes'] !== canonicalRow.length ||
    value['appendDigest'] !== createHash('sha256').update(canonicalRow).digest('hex')) return null;
  const identity = value['fileIdentity'];
  if (!isPlainRecord(identity) || !hasOnlyKeys(identity, new Set([
    'device', 'inode', 'size', 'mtimeNs', 'ctimeNs',
  ])) || typeof identity['device'] !== 'string' || !/^\d+$/.test(identity['device']) ||
    typeof identity['inode'] !== 'string' || !/^\d+$/.test(identity['inode']) ||
    identity['size'] !== value['appendOffset'] ||
    typeof identity['mtimeNs'] !== 'string' || !/^-?\d+$/.test(identity['mtimeNs']) ||
    typeof identity['ctimeNs'] !== 'string' || !/^-?\d+$/.test(identity['ctimeNs'])) return null;
  return value as unknown as AttemptFailureAppendAuthority;
}

function failureAppendIdentityMatches(
  authority: AttemptFailureAppendAuthority,
  stat: BigIntStats,
): boolean {
  return safeBigIntDispatchProductionFile(stat) &&
    stat.dev.toString() === authority.fileIdentity.device &&
    stat.ino.toString() === authority.fileIdentity.inode;
}

function inspectFailureAttemptAppend(
  fd: number,
  path: string,
  authority: AttemptFailureAppendAuthority,
  canonicalRow: Buffer,
): 0 | 1 {
  const before = fstatSync(fd, { bigint: true });
  const namedBefore = lstatSync(path, { bigint: true });
  if (!failureAppendIdentityMatches(authority, before) ||
    !failureAppendIdentityMatches(authority, namedBefore) ||
    before.dev !== namedBefore.dev || before.ino !== namedBefore.ino) {
    throw new Error('attempt failure partition identity changed');
  }
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < authority.appendOffset) {
    throw new Error('attempt failure partition truncated');
  }
  if (size === authority.appendOffset) {
    if (before.mtimeNs.toString() !== authority.fileIdentity.mtimeNs ||
      before.ctimeNs.toString() !== authority.fileIdentity.ctimeNs) {
      throw new Error('attempt failure partition mutated before append');
    }
    return 0;
  }
  const appendEnd = authority.appendOffset + authority.appendBytes;
  if (!Number.isSafeInteger(appendEnd) || size < appendEnd) {
    throw new Error('attempt failure partition contains a partial append');
  }
  const exact = Buffer.alloc(authority.appendBytes);
  if (readSync(fd, exact, 0, exact.length, authority.appendOffset) !== exact.length ||
    !exact.equals(canonicalRow) ||
    createHash('sha256').update(exact).digest('hex') !== authority.appendDigest) {
    throw new Error('attempt failure exact append changed');
  }
  const after = fstatSync(fd, { bigint: true });
  const namedAfter = lstatSync(path, { bigint: true });
  if (!sameBigIntSnapshot(before, after) || !sameBigIntSnapshot(namedBefore, namedAfter) ||
    before.dev !== namedBefore.dev || before.ino !== namedBefore.ino) {
    throw new Error('attempt failure partition changed during exact read');
  }
  return 1;
}

function recordAttemptProductionWithReceipt(
  event: DispatchProductionEvent,
  canonicalLine: string,
  append: () => void,
): void {
  assertStableDispatchProductionWriteRoot();
  const dir = attemptProofReceiptDir();
  ensurePrivateReceiptDirectory(dir);
  const lock = acquireLocalStoreLock(attemptReceiptLockPath());
  if (!lock) throw new Error('attempt proof receipt lock unavailable');
  let tmp: string | null = null;
  try {
    cleanupStaleAttemptReceiptStages(dir);
    let activation = ensureAttemptReceiptProtocolActivation(dir, event);
    activation = recoverAttemptReceiptRetention(dir, activation);
    activation = admitAttemptReceiptGeneration(dir, activation, event);
    const generationId = event.repairGenerationId!;
    const ordinal = event.repairAttemptOrdinal!;
    const path = join(dir, attemptProofReceiptName(generationId, ordinal));
    const intentPath = attemptReceiptIntentPath(generationId, ordinal);
    const wantedDigest = createHash('sha256').update(canonicalLine, 'utf8').digest('hex');
    if (existsSync(path)) {
      const loaded = readAttemptProofReceipt(generationId, ordinal);
      if (loaded.status !== 'proven' || loaded.authority.proof.eventDigest !== wantedDigest) {
        throw new Error('conflicting attempt proof receipt');
      }
      return;
    }
    if (existsSync(intentPath)) {
      const pending = readAttemptProofReceiptFile(intentPath, generationId, ordinal, true);
      if (pending.status === 'proven') {
        assertStableDispatchProductionWriteRoot();
        renameSync(intentPath, path);
        inspectExactReceiptAuthorityFile(path);
        fsyncDirectory(dir);
        if (pending.authority.proof.eventDigest !== wantedDigest) {
          throw new Error('conflicting committed attempt proof intent');
        }
        return;
      }
      if (pending.status !== 'intent') throw new Error('invalid attempt proof intent');
      assertStableDispatchProductionWriteRoot();
      unlinkSync(intentPath);
      fsyncDirectory(dir);
    }
    const retentionPlan = planAttemptProofReceiptRetention(dir, generationId, activation);
    if (retentionPlan) {
      activation = applyAttemptReceiptRetention(dir, retentionPlan, activation);
    }
    const bytes = Buffer.from(`${attemptReceiptEnvelope(event, activation.activationId)}\n`, 'utf8');
    if (bytes.length > MAX_READ_ROW_BYTES) throw new Error('attempt proof receipt too large');
    tmp = attemptReceiptStagePath(intentPath);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('short attempt proof intent write');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      secureCreatedReceiptTempFile(tmp);
      assertStableDispatchProductionWriteRoot();
      renameSync(tmp, intentPath);
      tmp = null;
      inspectExactReceiptAuthorityFile(intentPath);
      fsyncDirectory(dir);
      dispatchProductionLedgerRetentionHooksForTest?.afterAttemptReceiptIntentAssured?.(intentPath);
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    }
    append();
    assertStableDispatchProductionWriteRoot();
    renameSync(intentPath, path);
    inspectExactReceiptAuthorityFile(path);
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (tmp) cleanupDispatchProductionWriteTemp(tmp);
    releaseLocalStoreLock(lock);
  }
}

function countAttemptReceiptAuthorityArtifacts(dir: string): number {
  let count = 0;
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES) {
        throw new Error('attempt receipt directory scan limit');
      }
      if (ATTEMPT_RECEIPT_FILE_RE.test(entry.name) ||
        ATTEMPT_RECEIPT_INTENT_FILE_RE.test(entry.name) ||
        ATTEMPT_FAILURE_RECEIPT_FILE_RE.test(entry.name) ||
        ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.test(entry.name)) count++;
    }
  } finally { handle.closeSync(); }
  return count;
}

function recordFailureAttemptProductionWithReceipt(
  event: DispatchProductionEvent,
  canonicalLine: string,
): void {
  assertStableDispatchProductionWriteRoot();
  const dir = attemptProofReceiptDir();
  ensurePrivateReceiptDirectory(dir);
  const lock = acquireLocalStoreLock(attemptReceiptLockPath());
  if (!lock) throw new Error('attempt failure receipt lock unavailable');
  let tmp: string | null = null;
  try {
    cleanupStaleAttemptReceiptStages(dir);
    let activation = ensureAttemptReceiptProtocolActivation(dir, event);
    activation = recoverAttemptReceiptRetention(dir, activation);
    activation = admitAttemptReceiptGeneration(dir, activation, event);
    const authority = parseDispatchProductionFailureAttemptAuthority(event, canonicalLine);
    if (authority === null) throw new Error('ineligible attempt failure receipt');
    const { repairGenerationId: generationId, repairAttemptOrdinal: ordinal, attemptHash } = authority.proof;
    const path = join(dir, attemptFailureReceiptName(generationId, ordinal, attemptHash));
    const intentPath = attemptFailureReceiptIntentPath(generationId, ordinal, attemptHash);
    if (existsSync(path)) {
      const loaded = readFailureAttemptReceiptFile(path, generationId, ordinal, attemptHash, activation);
      if (loaded.status !== 'proven' || loaded.proof.eventDigest !== authority.proof.eventDigest) {
        throw new Error('conflicting attempt failure receipt');
      }
      return;
    }
    if (existsSync(intentPath)) {
      const pending = readFailureAttemptReceiptFile(
        intentPath, generationId, ordinal, attemptHash, activation,
      );
      if (pending.status === 'proven') {
        if (pending.proof.eventDigest !== authority.proof.eventDigest) {
          throw new Error('conflicting committed attempt failure intent');
        }
        if (!pending.appendAuthority) {
          throw new Error('legacy attempt failure intent append authority unavailable');
        }
        const partition = join(
          dispatchProductionDir(), `${pending.appendAuthority.partitionDate}.jsonl`,
        );
        const partitionLock = acquireLocalStoreLock(`${partition}.lock`);
        if (!partitionLock) throw new Error('attempt failure partition lock unavailable');
        let partitionFd: number | undefined;
        try {
          partitionFd = openSync(
            partition,
            fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
          );
          const canonicalRow = Buffer.from(`${canonicalLine}\n`, 'utf8');
          const appended = inspectFailureAttemptAppend(
            partitionFd, partition, pending.appendAuthority, canonicalRow,
          );
          if (appended === 0 && writeSync(partitionFd, canonicalRow) !== canonicalRow.length) {
            throw new Error('short attempt failure exact append');
          }
          if (appended === 0) fsyncSync(partitionFd);
          dispatchProductionLedgerRetentionHooksForTest?.afterFailureAttemptAppend?.();
          if (inspectFailureAttemptAppend(
            partitionFd, partition, pending.appendAuthority, canonicalRow,
          ) !== 1) throw new Error('attempt failure exact append did not commit');
          assertStableDispatchProductionWriteRoot();
          renameSync(intentPath, path);
          inspectExactReceiptAuthorityFile(path);
          fsyncDirectory(dir);
          return;
        } finally {
          if (partitionFd !== undefined) {
            try { closeSync(partitionFd); } catch { /* preserve primary failure */ }
          }
          releaseLocalStoreLock(partitionLock);
        }
      }
      throw new Error('invalid attempt failure intent');
    }
    const retentionPlan = planAttemptProofReceiptRetention(dir, generationId, activation);
    if (retentionPlan) {
      activation = applyAttemptReceiptRetention(dir, retentionPlan, activation);
    }
    if (countAttemptReceiptAuthorityArtifacts(dir) >= MAX_ATTEMPT_PROOF_RECEIPTS) {
      throw new Error('attempt failure receipt capacity unavailable');
    }
    const partition = join(dispatchProductionDir(), `${eventDateString(event.ts)}.jsonl`);
    const partitionLock = acquireLocalStoreLock(`${partition}.lock`);
    if (!partitionLock) throw new Error('attempt failure partition lock unavailable');
    let partitionFd: number | undefined;
    try {
      const existed = existsSync(partition);
      partitionFd = openSync(
        partition,
        fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const opened = fstatSync(partitionFd);
      const named = lstatSync(partition);
      if (!safeDispatchProductionFile(opened) || !safeDispatchProductionFile(named) ||
        !sameFile(opened, named)) throw new Error('unsafe attempt failure partition');
      if (!existed) fsyncDirectory(dirname(partition));
      if (opened.size > 0) {
        const tail = Buffer.alloc(1);
        if (readSync(partitionFd, tail, 0, 1, opened.size - 1) !== 1) {
          throw new Error('attempt failure partition tail unavailable');
        }
        if (tail[0] !== 0x0a) {
          if (writeSync(partitionFd, Buffer.from('\n', 'utf8')) !== 1) {
            throw new Error('short attempt failure partition separator append');
          }
          fsyncSync(partitionFd);
        }
      }
      const canonicalRow = Buffer.from(`${canonicalLine}\n`, 'utf8');
      const appendAuthority = attemptFailureAppendAuthority(
        event, canonicalRow, fstatSync(partitionFd, { bigint: true }),
      );
      const bytes = Buffer.from(`${attemptFailureReceiptEnvelope(
        event, activation.activationId, appendAuthority,
      )}\n`, 'utf8');
      if (bytes.length > MAX_ATTEMPT_FAILURE_RECEIPT_BYTES) {
        throw new Error('attempt failure receipt too large');
      }
      tmp = attemptReceiptStagePath(intentPath);
      let fd: number | undefined;
      try {
        fd = openSync(
          tmp,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
        if (writeSync(fd, bytes) !== bytes.length) throw new Error('short attempt failure intent write');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        secureCreatedReceiptTempFile(tmp);
        assertStableDispatchProductionWriteRoot();
        renameSync(tmp, intentPath);
        tmp = null;
        inspectExactReceiptAuthorityFile(intentPath);
        fsyncDirectory(dir);
      } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
      }
      if (inspectFailureAttemptAppend(
        partitionFd, partition, appendAuthority, canonicalRow,
      ) !== 0) throw new Error('attempt failure append already present before commit');
      if (writeSync(partitionFd, canonicalRow) !== canonicalRow.length) {
        throw new Error('short attempt failure exact append');
      }
      fsyncSync(partitionFd);
      dispatchProductionLedgerRetentionHooksForTest?.afterFailureAttemptAppend?.();
      if (inspectFailureAttemptAppend(
        partitionFd, partition, appendAuthority, canonicalRow,
      ) !== 1) throw new Error('attempt failure exact append did not commit');
      assertStableDispatchProductionWriteRoot();
      renameSync(intentPath, path);
      inspectExactReceiptAuthorityFile(path);
      fsyncDirectory(dir);
      assertStableDispatchProductionWriteRoot();
    } finally {
      if (partitionFd !== undefined) {
        try { closeSync(partitionFd); } catch { /* preserve primary failure */ }
      }
      releaseLocalStoreLock(partitionLock);
    }
  } finally {
    if (tmp) cleanupDispatchProductionWriteTemp(tmp);
    releaseLocalStoreLock(lock);
  }
}
