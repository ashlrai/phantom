/** Exact treatment outcome receipts and compaction. */

import type {
  DispatchProductionEvent,
  DispatchProductionEventsReadResult,
  ReadDispatchProductionEventsOptions,
} from './types.js';
import { createHash } from 'node:crypto';
import {
  TREATMENT_RECEIPT_DIGEST_DOMAIN,
  TREATMENT_RETENTION_COMPACTION_DOMAIN,
  TREATMENT_RETENTION_DIGEST_DOMAIN,
  TREATMENT_RECEIPT_PROTOCOL_FILE,
  TREATMENT_RECEIPT_COMPACTED_DIR,
  TREATMENT_RECEIPT_FILE_RE,
  MAX_TREATMENT_COMPACTED_MARKER_BYTES,
  SHA256_RE,
  MAX_TREATMENT_COMPACTED_MARKERS,
  MAX_TREATMENT_COMPACTED_MARKER_AGGREGATE_BYTES,
  TREATMENT_RECEIPT_RETENTION_FILE,
  MAX_TREATMENT_RECEIPT_RETENTION_BYTES,
  MAX_TREATMENT_RECEIPT_TOMBSTONES,
  MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES,
  DISPATCH_PRODUCTION_EVENT_KEYS,
  MAX_TREATMENT_RECEIPT_BYTES,
  MAX_READ_ROW_BYTES,
  HARD_READ_MAX_BYTES,
  HARD_READ_MAX_ROWS,
  MAX_TREATMENT_RECEIPT_DIR_ENTRIES,
  MAX_TREATMENT_RECEIPT_AGGREGATE_BYTES,
  MAX_TREATMENT_OUTCOME_RECEIPTS,
} from './constants.js';
import { sanitizeProductionAttemptLearningLabel } from '../../learning/attempt-shape.js';
import {
  isPlainRecord,
  hasOnlyKeys,
  canonicalUtcTimestamp,
  storedLearningLabelOrigin,
  hasOwn,
  canonicalStoredDispatchProductionEvent,
  listAttemptProofPartitionDates,
  withLearningLabelOrigin,
} from './attempt-proofs.js';
import { join, dirname } from 'node:path';
import {
  treatmentOutcomeReceiptDir,
  inspectExactReceiptAuthorityDirectory,
  dispatchProductionDir,
  inspectExactReceiptAuthorityFile,
  safeDispatchProductionFile,
  ensurePrivateReceiptDirectory,
  secureCreatedReceiptTempFile,
  assertStableDispatchProductionWriteRoot,
  treatmentOutcomeReceiptName,
  safeDispatchProductionDirectory,
  sameFile,
  pushStopReason,
  readDispatchProductionFileTail,
  recordDispatchProductionInvalidReason,
} from './storage.js';
import {
  type StableFileBatchAssurance,
  readStableRegularFile,
  openStableDirectoryGuard,
} from '../../util/stable-file-read.js';
import {
  existsSync,
  opendirSync,
  lstatSync,
  openSync,
  constants as fsConstants,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import {
  assureRetentionFiles,
  dispatchProductionLedgerRetentionHooksForTest,
} from './retention-hooks.js';
import { attemptReceiptStagePath, cleanupDispatchProductionWriteTemp } from './write.js';
import { fsyncDirectory } from '../../util/durability.js';
import { sanitizeDispatchProductionEvent, isDispatchProductionEvent } from './events.js';
import { generatedRepairLifecycleAttemptHash } from '../generated-repair-identity.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../local-store-lock.js';
import { assurePrivateStoragePath } from '../../util/private-storage.js';

interface TreatmentReceiptTombstone {
  name: string;
  receiptDigest: string;
}

interface TreatmentReceiptRetentionState {
  schemaVersion: 1 | 2 | 3;
  droppedThrough: string;
  retirementEpoch: number;
  previousRetentionDigest: string | null;
  compactedDigest: string;
  compactedCount: number;
  tombstones: TreatmentReceiptTombstone[];
}

interface TreatmentReceiptProtocolState {
  schemaVersion: 1;
  retirementEpoch: number;
  retentionDigest: string | null;
}

interface TreatmentCompactedReceiptMarker extends TreatmentReceiptTombstone {
  schemaVersion: 1;
}

interface TreatmentReceiptAuthorityState {
  retention: TreatmentReceiptRetentionState | null;
  compactedMarkers: Map<string, TreatmentCompactedReceiptMarker>;
  observedCompactedMarkers: Map<string, TreatmentCompactedReceiptMarker>;
  pendingCompaction: boolean;
}

function rawTreatmentOutcomeReceiptDigest(
  name: string,
  event: DispatchProductionEvent,
): string {
  return createHash('sha256')
    .update(TREATMENT_RECEIPT_DIGEST_DOMAIN, 'utf8')
    .update(name, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(event), 'utf8')
    .digest('hex');
}

function treatmentOutcomeReceiptDigest(
  name: string,
  event: DispatchProductionEvent,
): string {
  const storedLabel: unknown = event.learningLabel;
  const normalizedLabel = sanitizeProductionAttemptLearningLabel(storedLabel);
  const digestEvent = isPlainRecord(storedLabel) &&
    storedLabel['classifierVersion'] === 'attempt-shape-v1' &&
    normalizedLabel !== undefined
    ? { ...event, learningLabel: normalizedLabel }
    : event;
  return rawTreatmentOutcomeReceiptDigest(name, digestEvent);
}

function treatmentOutcomeReceiptDigestMatchesExpected(
  digest: string,
  name: string,
  expected: DispatchProductionEvent,
): boolean {
  if (digest === treatmentOutcomeReceiptDigest(name, expected)) return true;
  if (expected.learningLabel === undefined) return false;
  const legacyExpected = {
    ...expected,
    learningLabel: {
      ...expected.learningLabel,
      classifierVersion: 'attempt-shape-v1',
    },
  } as unknown as DispatchProductionEvent;
  return digest === rawTreatmentOutcomeReceiptDigest(name, legacyExpected);
}

function emptyTreatmentRetentionCompactedDigest(): string {
  return createHash('sha256').update(TREATMENT_RETENTION_COMPACTION_DOMAIN, 'utf8').digest('hex');
}

function treatmentReceiptRetentionDigest(state: TreatmentReceiptRetentionState): string {
  return createHash('sha256')
    .update(TREATMENT_RETENTION_DIGEST_DOMAIN, 'utf8')
    .update(JSON.stringify(state), 'utf8')
    .digest('hex');
}

function compactTreatmentReceiptTombstones(
  priorDigest: string,
  tombstones: readonly TreatmentReceiptTombstone[],
): string {
  let digest = priorDigest;
  const ordered = [...tombstones].sort((left, right) => left.name.localeCompare(right.name));
  for (const tombstone of ordered) {
    digest = createHash('sha256')
      .update(TREATMENT_RETENTION_COMPACTION_DOMAIN, 'utf8')
      .update(digest, 'utf8')
      .update('\0', 'utf8')
      .update(tombstone.name, 'utf8')
      .update('\0', 'utf8')
      .update(tombstone.receiptDigest, 'utf8')
      .digest('hex');
  }
  return digest;
}

function treatmentReceiptProtocolPath(): string {
  return join(treatmentOutcomeReceiptDir(), TREATMENT_RECEIPT_PROTOCOL_FILE);
}

function treatmentCompactedReceiptDir(): string {
  return join(treatmentOutcomeReceiptDir(), TREATMENT_RECEIPT_COMPACTED_DIR);
}

function treatmentCompactedReceiptPath(name: string): string {
  if (!TREATMENT_RECEIPT_FILE_RE.test(name)) throw new Error('invalid compacted treatment receipt name');
  return join(treatmentCompactedReceiptDir(), name);
}

function readCompactedTreatmentReceiptMarker(
  name: string,
  batchAssurance?: StableFileBatchAssurance,
): TreatmentCompactedReceiptMarker | null {
  const dir = treatmentCompactedReceiptDir();
  const path = treatmentCompactedReceiptPath(name);
  if (!existsSync(path)) return null;
  if (!batchAssurance) inspectExactReceiptAuthorityDirectory(dir);
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_TREATMENT_COMPACTED_MARKER_BYTES,
    remainingBytes: MAX_TREATMENT_COMPACTED_MARKER_BYTES,
    batchAssurance,
  });
  if (!loaded.ok || !loaded.text.endsWith('\n') ||
    loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    throw new Error('invalid compacted treatment receipt marker');
  }
  if (!batchAssurance) inspectExactReceiptAuthorityFile(path);
  const parsed: unknown = JSON.parse(loaded.text);
  if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, new Set([
    'schemaVersion', 'name', 'receiptDigest',
  ])) || parsed['schemaVersion'] !== 1 || parsed['name'] !== name ||
    typeof parsed['receiptDigest'] !== 'string' || !SHA256_RE.test(parsed['receiptDigest']) ||
    `${JSON.stringify(parsed)}\n` !== loaded.text) {
    throw new Error('invalid compacted treatment receipt marker');
  }
  return {
    schemaVersion: 1,
    name,
    receiptDigest: parsed['receiptDigest'],
  };
}

function readCompactedTreatmentReceiptMarkerSet(): TreatmentCompactedReceiptMarker[] {
  const dir = treatmentCompactedReceiptDir();
  if (!existsSync(dir)) return [];
  inspectExactReceiptAuthorityDirectory(dir);
  const guard = openStableDirectoryGuard(dir, { anchorPath: dispatchProductionDir() });
  if (!guard.ok) throw new Error('unsafe compacted treatment receipt marker directory');
  let finished = false;
  try {
    const names: string[] = [];
    const handle = opendirSync(dir);
    try {
      let physical = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physical++;
        if (physical > MAX_TREATMENT_COMPACTED_MARKERS) {
          throw new Error('compacted treatment receipt marker directory limit');
        }
        if (!TREATMENT_RECEIPT_FILE_RE.test(entry.name)) {
          throw new Error('unexpected compacted treatment receipt marker entry');
        }
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    names.sort((left, right) => left.localeCompare(right));
    if (names.some((name, index) => index > 0 && names[index - 1] === name)) {
      throw new Error('duplicate compacted treatment receipt marker');
    }
    let aggregateBytes = 0;
    for (const name of names) {
      const stat = lstatSync(join(dir, name));
      if (!safeDispatchProductionFile(stat) || stat.size < 2 ||
        stat.size > MAX_TREATMENT_COMPACTED_MARKER_BYTES) {
        throw new Error('unsafe compacted treatment receipt marker');
      }
      aggregateBytes += stat.size;
      if (aggregateBytes > MAX_TREATMENT_COMPACTED_MARKER_AGGREGATE_BYTES) {
        throw new Error('compacted treatment receipt marker aggregate byte limit');
      }
    }
    const markers: TreatmentCompactedReceiptMarker[] = [];
    for (let offset = 0; offset < names.length; offset += 512) {
      const batchNames = names.slice(offset, offset + 512);
      const paths = batchNames.map((name) => join(dir, name));
      const assurance = assureRetentionFiles(paths, dispatchProductionDir());
      if (!assurance.ok) throw new Error('unsafe compacted treatment receipt marker batch');
      for (let index = 0; index < batchNames.length; index++) {
        const marker = readCompactedTreatmentReceiptMarker(
          batchNames[index]!, assurance.token,
        );
        if (marker === null) throw new Error('missing compacted treatment receipt marker');
        markers.push(marker);
      }
    }
    const guardFailure = guard.finish();
    finished = true;
    if (guardFailure !== null) {
      throw new Error('compacted treatment receipt marker directory changed');
    }
    return markers;
  } finally {
    if (!finished) guard.finish();
  }
}

function treatmentCompactedMarkerAggregate(
  markers: readonly TreatmentCompactedReceiptMarker[],
): { count: number; digest: string } {
  if (markers.length > MAX_TREATMENT_COMPACTED_MARKERS) {
    throw new Error('compacted treatment receipt marker count limit');
  }
  return {
    count: markers.length,
    digest: compactTreatmentReceiptTombstones(
      emptyTreatmentRetentionCompactedDigest(), markers,
    ),
  };
}

function validateCommittedTreatmentCompactedMarkers(
  retention: TreatmentReceiptRetentionState | null,
  markers: readonly TreatmentCompactedReceiptMarker[],
): Map<string, TreatmentCompactedReceiptMarker> {
  const aggregate = treatmentCompactedMarkerAggregate(markers);
  const expectedCount = retention?.compactedCount ?? 0;
  const expectedDigest = retention?.compactedDigest ?? emptyTreatmentRetentionCompactedDigest();
  if (aggregate.count !== expectedCount || aggregate.digest !== expectedDigest) {
    throw new Error('compacted treatment receipt marker aggregate mismatch');
  }
  const byName = new Map<string, TreatmentCompactedReceiptMarker>();
  const looseByName = new Map((retention?.tombstones ?? []).map((value) => [value.name, value]));
  for (const marker of markers) {
    if (byName.has(marker.name)) {
      throw new Error('duplicate compacted treatment receipt marker');
    }
    const loose = looseByName.get(marker.name);
    if (loose) {
      throw new Error(loose.receiptDigest === marker.receiptDigest
        ? 'duplicate treatment receipt retirement marker'
        : 'conflicting treatment receipt retirement marker');
    }
    byName.set(marker.name, marker);
  }
  return byName;
}

function writeCompactedTreatmentReceiptMarkers(
  tombstones: readonly TreatmentReceiptTombstone[],
): void {
  if (tombstones.length === 0) return;
  for (const tombstone of tombstones) {
    const existing = readCompactedTreatmentReceiptMarker(tombstone.name);
    if (existing && existing.receiptDigest !== tombstone.receiptDigest) {
      throw new Error('conflicting compacted treatment receipt marker');
    }
    const marker: TreatmentCompactedReceiptMarker = { schemaVersion: 1, ...tombstone };
    if (Buffer.byteLength(`${JSON.stringify(marker)}\n`, 'utf8') >
      MAX_TREATMENT_COMPACTED_MARKER_BYTES) {
      throw new Error('compacted treatment receipt marker too large');
    }
  }
  const dir = treatmentCompactedReceiptDir();
  ensurePrivateReceiptDirectory(dir);
  let installed = false;
  for (const tombstone of tombstones) {
    const path = treatmentCompactedReceiptPath(tombstone.name);
    const existing = readCompactedTreatmentReceiptMarker(tombstone.name);
    if (existing) {
      if (existing.receiptDigest !== tombstone.receiptDigest) {
        throw new Error('conflicting compacted treatment receipt marker');
      }
      continue;
    }
    const marker: TreatmentCompactedReceiptMarker = { schemaVersion: 1, ...tombstone };
    const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
    if (bytes.length > MAX_TREATMENT_COMPACTED_MARKER_BYTES) {
      throw new Error('compacted treatment receipt marker too large');
    }
    const tmp = attemptReceiptStagePath(path);
    let fd: number | undefined;
    try {
      fd = openSync(
        tmp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      if (writeSync(fd, bytes) !== bytes.length) {
        throw new Error('short compacted treatment receipt marker write');
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      secureCreatedReceiptTempFile(tmp);
      assertStableDispatchProductionWriteRoot();
      renameSync(tmp, path);
      inspectExactReceiptAuthorityFile(path);
      installed = true;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
      cleanupDispatchProductionWriteTemp(tmp);
    }
  }
  if (installed) fsyncDirectory(dir);
  assertStableDispatchProductionWriteRoot();
}

function readRawTreatmentReceiptRetentionState(): TreatmentReceiptRetentionState | null {
  const path = join(treatmentOutcomeReceiptDir(), TREATMENT_RECEIPT_RETENTION_FILE);
  if (!existsSync(path)) return null;
  inspectExactReceiptAuthorityDirectory(treatmentOutcomeReceiptDir());
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_TREATMENT_RECEIPT_RETENTION_BYTES,
    remainingBytes: MAX_TREATMENT_RECEIPT_RETENTION_BYTES,
  });
  if (!loaded.ok || !loaded.text.endsWith('\n') ||
    loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    throw new Error('invalid treatment receipt retention marker');
  }
  inspectExactReceiptAuthorityFile(path);
  const parsed: unknown = JSON.parse(loaded.text);
  if (`${JSON.stringify(parsed)}\n` !== loaded.text) {
    throw new Error('invalid treatment receipt retention marker');
  }
  const droppedThrough = isPlainRecord(parsed)
    ? canonicalUtcTimestamp(parsed['droppedThrough'])
    : null;
  if (!isPlainRecord(parsed) || droppedThrough === null) {
    throw new Error('invalid treatment receipt retention marker');
  }
  if (parsed['schemaVersion'] === 1) {
    if (!hasOnlyKeys(parsed, new Set(['schemaVersion', 'droppedThrough']))) {
      throw new Error('invalid treatment receipt retention marker');
    }
    return {
      schemaVersion: 1,
      droppedThrough,
      retirementEpoch: 0,
      previousRetentionDigest: null,
      compactedDigest: emptyTreatmentRetentionCompactedDigest(),
      compactedCount: 0,
      tombstones: [],
    };
  }
  const schemaVersion = parsed['schemaVersion'];
  const keys = schemaVersion === 3
    ? new Set([
      'schemaVersion', 'droppedThrough', 'retirementEpoch', 'previousRetentionDigest',
      'compactedDigest', 'compactedCount', 'tombstones',
    ])
    : new Set(['schemaVersion', 'droppedThrough', 'retirementEpoch', 'tombstones']);
  if ((schemaVersion !== 2 && schemaVersion !== 3) || !hasOnlyKeys(parsed, keys) ||
    !Number.isSafeInteger(parsed['retirementEpoch']) ||
    (parsed['retirementEpoch'] as number) < 1 || !Array.isArray(parsed['tombstones']) ||
    (schemaVersion === 2 && parsed['tombstones'].length < 1) ||
    parsed['tombstones'].length > MAX_TREATMENT_RECEIPT_TOMBSTONES) {
    throw new Error('invalid treatment receipt retention marker');
  }
  const previousRetentionDigest = schemaVersion === 3 ? parsed['previousRetentionDigest'] : null;
  const compactedDigest = schemaVersion === 3
    ? parsed['compactedDigest']
    : emptyTreatmentRetentionCompactedDigest();
  const compactedCount = schemaVersion === 3 ? parsed['compactedCount'] : 0;
  if ((previousRetentionDigest !== null &&
      (typeof previousRetentionDigest !== 'string' || !SHA256_RE.test(previousRetentionDigest))) ||
    typeof compactedDigest !== 'string' || !SHA256_RE.test(compactedDigest) ||
    !Number.isSafeInteger(compactedCount) || (compactedCount as number) < 0) {
    throw new Error('invalid treatment receipt retention marker');
  }
  const tombstones: TreatmentReceiptTombstone[] = [];
  for (const value of parsed['tombstones']) {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, new Set(['name', 'receiptDigest'])) ||
      typeof value['name'] !== 'string' || !TREATMENT_RECEIPT_FILE_RE.test(value['name']) ||
      typeof value['receiptDigest'] !== 'string' || !SHA256_RE.test(value['receiptDigest'])) {
      throw new Error('invalid treatment receipt retention marker');
    }
    tombstones.push({ name: value['name'], receiptDigest: value['receiptDigest'] });
  }
  if (tombstones.some((value, index) =>
    index > 0 && tombstones[index - 1]!.name >= value.name)) {
    throw new Error('invalid treatment receipt retention marker');
  }
  return {
    schemaVersion: schemaVersion as 2 | 3,
    droppedThrough,
    retirementEpoch: parsed['retirementEpoch'] as number,
    previousRetentionDigest,
    compactedDigest,
    compactedCount: compactedCount as number,
    tombstones,
  };
}

function readTreatmentReceiptProtocolState(): TreatmentReceiptProtocolState | null {
  const path = treatmentReceiptProtocolPath();
  if (!existsSync(path)) return null;
  inspectExactReceiptAuthorityDirectory(treatmentOutcomeReceiptDir());
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES,
    remainingBytes: MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES,
  });
  if (!loaded.ok || !loaded.text.endsWith('\n') ||
    loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    throw new Error('invalid treatment receipt protocol');
  }
  inspectExactReceiptAuthorityFile(path);
  const parsed: unknown = JSON.parse(loaded.text);
  if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, new Set([
    'schemaVersion', 'retirementEpoch', 'retentionDigest',
  ])) || parsed['schemaVersion'] !== 1 ||
    !Number.isSafeInteger(parsed['retirementEpoch']) || (parsed['retirementEpoch'] as number) < 0 ||
    (parsed['retentionDigest'] !== null &&
      (typeof parsed['retentionDigest'] !== 'string' || !SHA256_RE.test(parsed['retentionDigest']))) ||
    `${JSON.stringify(parsed)}\n` !== loaded.text) {
    throw new Error('invalid treatment receipt protocol');
  }
  return {
    schemaVersion: 1,
    retirementEpoch: parsed['retirementEpoch'] as number,
    retentionDigest: parsed['retentionDigest'] as string | null,
  };
}

function readBoundTreatmentReceiptRetentionState(): TreatmentReceiptRetentionState | null {
  const state = readRawTreatmentReceiptRetentionState();
  const protocol = readTreatmentReceiptProtocolState();
  if (state === null) {
    if (protocol === null || (protocol.retirementEpoch === 0 && protocol.retentionDigest === null)) {
      return null;
    }
    throw new Error('treatment receipt retention anchor missing');
  }
  if (protocol === null) {
    if (state.schemaVersion !== 3) return state;
    throw new Error('treatment receipt protocol anchor missing');
  }
  const digest = treatmentReceiptRetentionDigest(state);
  if (protocol.retirementEpoch === state.retirementEpoch && protocol.retentionDigest === digest) {
    return state;
  }
  if (state.schemaVersion === 3 &&
    state.retirementEpoch === protocol.retirementEpoch + 1 &&
    state.previousRetentionDigest === protocol.retentionDigest) {
    return state;
  }
  throw new Error('treatment receipt retention rollback detected');
}

function markerMap(
  markers: readonly TreatmentCompactedReceiptMarker[],
): Map<string, TreatmentCompactedReceiptMarker> {
  return new Map(markers.map((marker) => [marker.name, marker]));
}

function readTreatmentReceiptAuthorityState(): TreatmentReceiptAuthorityState {
  const retention = readBoundTreatmentReceiptRetentionState();
  const observed = readCompactedTreatmentReceiptMarkerSet();
  const compactedMarkers = validateCommittedTreatmentCompactedMarkers(retention, observed);
  return {
    retention,
    compactedMarkers,
    observedCompactedMarkers: compactedMarkers,
    pendingCompaction: false,
  };
}

function pendingTreatmentCompactionMarkers(
  retention: TreatmentReceiptRetentionState,
): TreatmentReceiptTombstone[] {
  if (retention.schemaVersion !== 1) return retention.tombstones;
  const sources = readRetiredTreatmentOutcomeSources(retention.droppedThrough);
  if (sources.size === 0) {
    throw new Error('legacy treatment outcome retirement source unavailable');
  }
  return [...sources].map(([name, event]) => ({
    name,
    receiptDigest: treatmentOutcomeReceiptDigest(name, event),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function readTreatmentReceiptAuthorityStateForWrite(): TreatmentReceiptAuthorityState {
  const retention = readBoundTreatmentReceiptRetentionState();
  const observed = readCompactedTreatmentReceiptMarkerSet();
  try {
    const compactedMarkers = validateCommittedTreatmentCompactedMarkers(retention, observed);
    return {
      retention,
      compactedMarkers,
      observedCompactedMarkers: compactedMarkers,
      pendingCompaction: false,
    };
  } catch (committedError) {
    if (retention === null) throw committedError;
    const pending = pendingTreatmentCompactionMarkers(retention);
    if (pending.length === 0) throw committedError;
    const pendingByName = new Map(pending.map((marker) => [marker.name, marker]));
    if (pendingByName.size !== pending.length) {
      throw new Error('duplicate pending compacted treatment receipt marker');
    }
    const foundPending = new Set<string>();
    const committedObserved: TreatmentCompactedReceiptMarker[] = [];
    for (const marker of observed) {
      const expected = pendingByName.get(marker.name);
      if (!expected) {
        committedObserved.push(marker);
        continue;
      }
      if (expected.receiptDigest !== marker.receiptDigest) {
        throw new Error('conflicting pending compacted treatment receipt marker');
      }
      foundPending.add(marker.name);
    }
    if (foundPending.size !== pending.length) throw committedError;
    const compactedMarkers = validateCommittedTreatmentCompactedMarkers(
      retention, committedObserved,
    );
    return {
      retention,
      compactedMarkers,
      observedCompactedMarkers: markerMap(observed),
      pendingCompaction: true,
    };
  }
}

function readTreatmentReceiptRetentionState(): TreatmentReceiptRetentionState | null {
  return readTreatmentReceiptAuthorityState().retention;
}

function treatmentReceiptLockPath(): string {
  return join(treatmentOutcomeReceiptDir(), '.receipts.lock');
}

function treatmentReceiptEventMatchesExpected(
  stored: DispatchProductionEvent,
  expected: DispatchProductionEvent,
): boolean {
  if (JSON.stringify(stored) === JSON.stringify(expected)) return true;
  if (storedLearningLabelOrigin(stored.learningLabel) !== 'stored-legacy') return false;
  const normalizedLabel = sanitizeProductionAttemptLearningLabel(stored.learningLabel);
  return normalizedLabel !== undefined &&
    JSON.stringify({ ...stored, learningLabel: normalizedLabel }) === JSON.stringify(expected);
}

/** Verify an exact immutable terminal-outcome receipt without writing or repairing storage. */
export function hasExactDispatchProductionTreatmentOutcomeReceipt(
  expected: DispatchProductionEvent,
): boolean {
  let canonical: DispatchProductionEvent;
  try {
    canonical = sanitizeDispatchProductionEvent(expected, { materializeLearningLabel: true });
  } catch {
    return false;
  }
  const name = treatmentOutcomeReceiptName(canonical);
  if (name === null) return false;
  try {
    const authority = readTreatmentReceiptAuthorityState();
    const retention = authority.retention;
    const wantedDigest = treatmentOutcomeReceiptDigest(name, canonical);
    const tombstone = retention?.tombstones.find((value) => value.name === name);
    const compacted = authority.compactedMarkers.get(name);
    const retired = tombstone ?? compacted;
    const path = join(treatmentOutcomeReceiptDir(), name);
    if (!existsSync(path)) {
      if (retired) {
        return treatmentOutcomeReceiptDigestMatchesExpected(
          retired.receiptDigest, name, canonical,
        );
      }
      const retiredSource = retention?.schemaVersion === 1
        ? readRetiredTreatmentOutcomeSources(retention.droppedThrough).get(name)
        : undefined;
      return retiredSource !== undefined &&
        treatmentReceiptEventMatchesExpected(retiredSource, canonical);
    }
    const artifact = readTreatmentOutcomeReceiptArtifact(path, name);
    if (retired) {
      return treatmentOutcomeReceiptDigestMatchesExpected(
        retired.receiptDigest, name, canonical,
      ) &&
        artifact.receiptDigest === wantedDigest &&
        treatmentReceiptEventMatchesExpected(artifact.event, canonical);
    }
    const retiredSource = retention?.schemaVersion === 1
      ? readRetiredTreatmentOutcomeSources(retention.droppedThrough).get(name)
      : undefined;
    if (retiredSource) {
      return treatmentReceiptEventMatchesExpected(retiredSource, canonical) &&
        treatmentReceiptEventMatchesExpected(artifact.event, canonical);
    }
    if (retention && Date.parse(artifact.ts) <= Date.parse(retention.droppedThrough)) return false;
    return artifact.receiptDigest === wantedDigest &&
      treatmentReceiptEventMatchesExpected(artifact.event, canonical);
  } catch {
    return false;
  }
}

interface TreatmentOutcomeReceiptArtifact extends TreatmentReceiptTombstone {
  event: DispatchProductionEvent;
  ts: string;
}

function withLegacyRunTrajectoryAlias(
  canonical: DispatchProductionEvent,
  value: Record<string, unknown>,
): DispatchProductionEvent | null {
  if (
    typeof value['runId'] !== 'string' ||
    typeof value['trajectoryId'] !== 'string' ||
    value['trajectoryId'] !== `run:${value['runId']}` ||
    generatedRepairLifecycleAttemptHash(value['runId']) !== value['repairTreatmentAttemptHash'] ||
    canonical.runId !== value['runId'] ||
    canonical.trajectoryId !== undefined
  ) return null;
  const entries: Array<[string, unknown]> = [];
  let inserted = false;
  for (const [key, entryValue] of Object.entries(canonical)) {
    entries.push([key, entryValue]);
    if (key === 'runId') {
      entries.push(['trajectoryId', value['trajectoryId']]);
      inserted = true;
    }
  }
  return inserted
    ? Object.fromEntries(entries) as unknown as DispatchProductionEvent
    : null;
}

function canonicalTreatmentOutcomeReceiptEvent(
  value: unknown,
  line: string,
  name: string,
): value is DispatchProductionEvent {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, DISPATCH_PRODUCTION_EVENT_KEYS) ||
    !isDispatchProductionEvent(value) || JSON.stringify(value) !== line ||
    canonicalUtcTimestamp(value['ts']) === null ||
    value['basis'] !== 'repair-lifecycle-outcome' ||
    treatmentOutcomeReceiptName(value) !== name ||
    hasOwn(value, 'repairLineageInvalid')) return false;
  try {
    const hashUsesRunId = typeof value.runId === 'string' &&
      generatedRepairLifecycleAttemptHash(value.runId) === value.repairTreatmentAttemptHash;
    const canonicalInput = hashUsesRunId && value.trajectoryId !== undefined
      ? { ...value, trajectoryId: undefined }
      : value;
    const canonical = sanitizeDispatchProductionEvent(
      canonicalInput,
      { materializeLearningLabel: true },
    );
    const candidates = [
      canonical,
      ...(hashUsesRunId
        ? [withLegacyRunTrajectoryAlias(canonical, value)].filter(
          (candidate): candidate is DispatchProductionEvent => candidate !== null,
        )
        : []),
    ];
    return candidates.some((candidate) => {
      if (JSON.stringify(candidate) === line) return true;
      if (candidate.learningLabel === undefined) return false;
      return JSON.stringify({
        ...candidate,
        learningLabel: {
          ...candidate.learningLabel,
          classifierVersion: 'attempt-shape-v1',
        },
      }) === line;
    });
  } catch {
    return false;
  }
}

function treatmentOutcomeReceiptLine(text: string): string | null {
  if (text.endsWith('\n')) {
    return text.indexOf('\n') === text.length - 1 ? text.slice(0, -1) : null;
  }
  return text.length > 0 && !text.includes('\n') ? text : null;
}

function readTreatmentOutcomeReceiptArtifact(
  path: string,
  name: string,
  batchAssurance?: StableFileBatchAssurance,
): TreatmentOutcomeReceiptArtifact {
  if (!batchAssurance) inspectExactReceiptAuthorityDirectory(treatmentOutcomeReceiptDir());
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_TREATMENT_RECEIPT_BYTES,
    remainingBytes: MAX_TREATMENT_RECEIPT_BYTES,
    ...(batchAssurance ? { batchAssurance } : {}),
  });
  const line = loaded.ok ? treatmentOutcomeReceiptLine(loaded.text) : null;
  if (line === null) {
    throw new Error('invalid treatment outcome receipt');
  }
  if (!batchAssurance) inspectExactReceiptAuthorityFile(path);
  const parsed: unknown = JSON.parse(line);
  if (!canonicalTreatmentOutcomeReceiptEvent(parsed, line, name)) {
    throw new Error('unbound treatment outcome receipt');
  }
  return {
    name,
    event: parsed,
    ts: parsed.ts,
    receiptDigest: treatmentOutcomeReceiptDigest(name, parsed),
  };
}

function treatmentOutcomeSourcesFromPartition(
  text: string,
  bytesRead: number,
  date: string,
  remainingRows: number,
): { sources: Map<string, DispatchProductionEvent>; rowsRead: number } {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') !== bytesRead || !text.endsWith('\n')) {
    throw new Error('invalid treatment outcome source partition');
  }
  const sources = new Map<string, DispatchProductionEvent>();
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > remainingRows) throw new Error('treatment outcome source row limit');
  for (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!canonicalStoredDispatchProductionEvent(parsed, line, date)) continue;
    const name = treatmentOutcomeReceiptName(parsed);
    if (name === null || !canonicalTreatmentOutcomeReceiptEvent(parsed, line, name)) continue;
    const previous = sources.get(name);
    if (previous && JSON.stringify(previous) !== line) {
      throw new Error('conflicting treatment outcome source identity');
    }
    sources.set(name, parsed);
  }
  return { sources, rowsRead: lines.length };
}

function readRetiredTreatmentOutcomeSources(
  droppedThrough: string,
): Map<string, DispatchProductionEvent> {
  const cutoffMs = Date.parse(droppedThrough);
  if (!Number.isFinite(cutoffMs)) throw new Error('invalid treatment outcome retirement cutoff');
  const dir = dispatchProductionDir();
  const before = lstatSync(dir);
  if (!safeDispatchProductionDirectory(before)) throw new Error('unsafe treatment outcome source directory');
  const partitions = listAttemptProofPartitionDates(dir, dirname(dir));
  if (!partitions.ok) throw new Error(`treatment outcome source ${partitions.reason}`);
  const cutoffDate = droppedThrough.slice(0, 10);
  const dates = partitions.dates.filter((date) => date <= cutoffDate);
  let remainingBytes = HARD_READ_MAX_BYTES;
  let remainingRows = HARD_READ_MAX_ROWS;
  const sources = new Map<string, DispatchProductionEvent>();
  for (const date of dates) {
    const path = join(dir, `${date}.jsonl`);
    const loaded = readStableRegularFile(path, {
      anchorPath: dirname(dir),
      maxFileBytes: HARD_READ_MAX_BYTES,
      remainingBytes,
    });
    if (!loaded.ok) throw new Error('treatment outcome source partition unavailable');
    remainingBytes -= loaded.bytesRead;
    const parsed = treatmentOutcomeSourcesFromPartition(
      loaded.text, loaded.bytesRead, date, remainingRows,
    );
    remainingRows -= parsed.rowsRead;
    for (const [name, event] of parsed.sources) {
      if (Date.parse(event.ts) > cutoffMs) continue;
      const previous = sources.get(name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
        throw new Error('conflicting retired treatment outcome source');
      }
      sources.set(name, event);
    }
  }
  const after = lstatSync(dir);
  if (!safeDispatchProductionDirectory(after) || !sameFile(before, after) ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error('treatment outcome source directory changed');
  }
  return sources;
}

export function persistTreatmentOutcomeReceipt(event: DispatchProductionEvent, name: string): void {
  assertStableDispatchProductionWriteRoot();
  const dir = treatmentOutcomeReceiptDir();
  ensurePrivateReceiptDirectory(dir);
  const path = join(dir, name);
  const lock = acquireLocalStoreLock(treatmentReceiptLockPath());
  if (!lock) throw new Error('treatment outcome receipt lock unavailable');
  let fd: number | undefined;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const authority = readTreatmentReceiptAuthorityStateForWrite();
    const retention = authority.retention;
    const wantedDigest = treatmentOutcomeReceiptDigest(name, event);
    const tombstone = retention?.tombstones.find((value) => value.name === name);
    const compacted = authority.compactedMarkers.get(name);
    const retired = tombstone ?? compacted;
    if (retired) {
      if (retired.receiptDigest !== wantedDigest) {
        throw new Error('conflicting retired treatment outcome receipt');
      }
      if (existsSync(path)) {
        const artifact = readTreatmentOutcomeReceiptArtifact(path, name);
        if (artifact.receiptDigest !== wantedDigest ||
          JSON.stringify(artifact.event) !== JSON.stringify(event)) {
          throw new Error('conflicting treatment outcome receipt');
        }
      }
      return;
    }
    const retiredSource = retention?.schemaVersion === 1
      ? readRetiredTreatmentOutcomeSources(retention.droppedThrough).get(name)
      : undefined;
    if (retiredSource) {
      if (JSON.stringify(retiredSource) !== JSON.stringify(event)) {
        throw new Error('conflicting retired treatment outcome source');
      }
      return;
    }
    if (existsSync(path)) {
      const artifact = readTreatmentOutcomeReceiptArtifact(path, name);
      if (artifact.receiptDigest !== wantedDigest ||
        JSON.stringify(artifact.event) !== JSON.stringify(event)) {
        throw new Error('conflicting treatment outcome receipt');
      }
      if (retention &&
        Date.parse(artifact.ts) <= Date.parse(retention.droppedThrough)) {
        throw new Error('restored retired treatment outcome receipt');
      }
      if (process.platform === 'win32' && !assurePrivateStoragePath(
        path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok) throw new Error('unsafe Windows treatment outcome receipt');
      return;
    }
    if (retention && Date.parse(event.ts) <= Date.parse(retention.droppedThrough)) {
      throw new Error('treatment outcome receipt retirement rollback detected');
    }
    pruneTreatmentOutcomeReceipts(dir);
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    if (bytes.length > MAX_TREATMENT_RECEIPT_BYTES) throw new Error('treatment outcome receipt too large');
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short treatment outcome receipt write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
    ).ok) throw new Error('unsafe Windows treatment outcome receipt');
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
    releaseLocalStoreLock(lock);
  }
}

function writeTreatmentReceiptRetention(
  dir: string,
  prior: TreatmentReceiptRetentionState | null,
  droppedThrough: string,
  additions: readonly TreatmentReceiptTombstone[],
): TreatmentReceiptRetentionState {
  assertStableDispatchProductionWriteRoot();
  const path = join(dir, TREATMENT_RECEIPT_RETENTION_FILE);
  const tmp = attemptReceiptStagePath(path);
  const observedAuthority = readTreatmentReceiptAuthorityStateForWrite();
  if (JSON.stringify(observedAuthority.retention) !== JSON.stringify(prior)) {
    throw new Error('treatment receipt retention changed');
  }
  if ((prior?.retirementEpoch ?? 0) >= Number.MAX_SAFE_INTEGER) {
    throw new Error('treatment receipt retirement epoch exhausted');
  }
  let compactedDigest = prior?.compactedDigest ?? emptyTreatmentRetentionCompactedDigest();
  let compactedCount = prior?.compactedCount ?? 0;
  const legacySources = prior?.schemaVersion === 1
    ? readRetiredTreatmentOutcomeSources(prior.droppedThrough)
    : null;
  if (legacySources?.size === 0) {
    throw new Error('legacy treatment outcome retirement source unavailable');
  }
  const legacyTombstones = legacySources
    ? [...legacySources].map(([name, event]) => ({
        name,
        receiptDigest: treatmentOutcomeReceiptDigest(name, event),
      })).sort((left, right) => left.name.localeCompare(right.name))
    : [];
  const inheritedTombstones = prior?.schemaVersion === 1
    ? legacyTombstones
    : (prior?.tombstones ?? []);
  let byName = new Map(inheritedTombstones.map((value) => [value.name, value]));
  for (const addition of additions) {
    const existing = byName.get(addition.name);
    if (existing && existing.receiptDigest !== addition.receiptDigest) {
      throw new Error('conflicting treatment receipt tombstone');
    }
    byName.set(addition.name, {
      name: addition.name,
      receiptDigest: addition.receiptDigest,
    });
  }
  let compactedAdditions: TreatmentReceiptTombstone[] = [];
  if (byName.size > MAX_TREATMENT_RECEIPT_TOMBSTONES) {
    const rotating = [...inheritedTombstones]
      .sort((left, right) => left.name.localeCompare(right.name));
    if (rotating.length === 0 ||
      (prior?.compactedCount ?? 0) > Number.MAX_SAFE_INTEGER - rotating.length) {
      throw new Error('treatment receipt tombstone compaction unavailable');
    }
    const compactedByName = new Map(observedAuthority.observedCompactedMarkers);
    for (const tombstone of rotating) {
      const existing = compactedByName.get(tombstone.name);
      if (existing && existing.receiptDigest !== tombstone.receiptDigest) {
        throw new Error('conflicting compacted treatment receipt marker');
      }
      compactedByName.set(tombstone.name, { schemaVersion: 1, ...tombstone });
    }
    const expectedCount = (prior?.compactedCount ?? 0) + rotating.length;
    if (compactedByName.size !== expectedCount) {
      throw new Error('unexpected pending compacted treatment receipt marker');
    }
    const aggregate = treatmentCompactedMarkerAggregate([...compactedByName.values()]);
    compactedDigest = aggregate.digest;
    compactedCount = aggregate.count;
    compactedAdditions = rotating;
    byName = new Map();
    for (const addition of additions) {
      byName.set(addition.name, {
        name: addition.name,
        receiptDigest: addition.receiptDigest,
      });
    }
  } else if (observedAuthority.pendingCompaction) {
    throw new Error('orphan compacted treatment receipt markers without compaction');
  }
  const tombstones = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (tombstones.length > MAX_TREATMENT_RECEIPT_TOMBSTONES) {
    throw new Error('treatment receipt tombstone rollover unavailable');
  }
  const nextMs = Math.max(
    prior ? Date.parse(prior.droppedThrough) : Number.NEGATIVE_INFINITY,
    Date.parse(droppedThrough),
  );
  if (!Number.isFinite(nextMs)) throw new Error('invalid treatment receipt retention timestamp');
  const next: TreatmentReceiptRetentionState = {
    schemaVersion: 3,
    droppedThrough: new Date(nextMs).toISOString(),
    retirementEpoch: (prior?.retirementEpoch ?? 0) + 1,
    previousRetentionDigest: prior === null ? null : treatmentReceiptRetentionDigest(prior),
    compactedDigest,
    compactedCount,
    tombstones,
  };
  const bytes = Buffer.from(`${JSON.stringify(next)}\n`, 'utf8');
  if (bytes.length > MAX_TREATMENT_RECEIPT_RETENTION_BYTES) {
    throw new Error('treatment receipt retention marker too large');
  }
  stabilizeTreatmentReceiptProtocol(dir, prior);
  writeCompactedTreatmentReceiptMarkers(compactedAdditions);
  if (compactedAdditions.length > 0) {
    dispatchProductionLedgerRetentionHooksForTest?.afterTreatmentCompactedMarkers?.();
  }
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short treatment receipt retention write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
    ).ok) throw new Error('unsafe Windows treatment receipt retention marker');
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
    if (JSON.stringify(readRawTreatmentReceiptRetentionState()) !== JSON.stringify(next) ||
      JSON.stringify(readTreatmentReceiptRetentionState()) !== JSON.stringify(next)) {
      throw new Error('treatment receipt retention installation changed');
    }
    return next;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
  }
}

function writeTreatmentReceiptProtocolState(
  dir: string,
  state: TreatmentReceiptProtocolState,
): void {
  assertStableDispatchProductionWriteRoot();
  const path = treatmentReceiptProtocolPath();
  const tmp = attemptReceiptStagePath(path);
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
  if (bytes.length > MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES) {
    throw new Error('treatment receipt protocol too large');
  }
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short treatment receipt protocol write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    inspectExactReceiptAuthorityFile(path);
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
    if (JSON.stringify(readTreatmentReceiptProtocolState()) !== JSON.stringify(state)) {
      throw new Error('treatment receipt protocol installation changed');
    }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
  }
}

function treatmentReceiptProtocolFor(
  state: TreatmentReceiptRetentionState | null,
): TreatmentReceiptProtocolState {
  return {
    schemaVersion: 1,
    retirementEpoch: state?.retirementEpoch ?? 0,
    retentionDigest: state === null ? null : treatmentReceiptRetentionDigest(state),
  };
}

function stabilizeTreatmentReceiptProtocol(
  dir: string,
  state: TreatmentReceiptRetentionState | null,
): void {
  const current = readTreatmentReceiptProtocolState();
  const wanted = treatmentReceiptProtocolFor(state);
  if (JSON.stringify(current) === JSON.stringify(wanted)) return;
  if (current === null) {
    if (state?.schemaVersion === 3) throw new Error('treatment receipt protocol anchor missing');
    writeTreatmentReceiptProtocolState(dir, wanted);
    return;
  }
  if (state?.schemaVersion === 3 &&
    state.retirementEpoch === current.retirementEpoch + 1 &&
    state.previousRetentionDigest === current.retentionDigest) {
    writeTreatmentReceiptProtocolState(dir, wanted);
    return;
  }
  throw new Error('treatment receipt protocol conflict');
}

function pruneTreatmentOutcomeReceipts(dir: string): void {
  assertStableDispatchProductionWriteRoot();
  const authority = readTreatmentReceiptAuthorityStateForWrite();
  const retention = authority.retention;
  if (retention?.schemaVersion !== 1) stabilizeTreatmentReceiptProtocol(dir, retention);
  const names: string[] = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_TREATMENT_RECEIPT_DIR_ENTRIES) throw new Error('treatment receipt directory limit');
      if (!TREATMENT_RECEIPT_FILE_RE.test(entry.name)) continue;
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  let aggregateBytes = 0;
  for (const name of names) {
    const stat = lstatSync(join(dir, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.size < 2 || stat.size > MAX_TREATMENT_RECEIPT_BYTES) {
      throw new Error('invalid treatment receipt allocation');
    }
    aggregateBytes += stat.size;
    if (aggregateBytes > MAX_TREATMENT_RECEIPT_AGGREGATE_BYTES) {
      throw new Error('treatment receipt aggregate byte limit');
    }
  }
  let receipts: TreatmentOutcomeReceiptArtifact[] = [];
  for (let offset = 0; offset < names.length; offset += 512) {
    const batchNames = names.slice(offset, offset + 512);
    const paths = batchNames.map((name) => join(dir, name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe treatment receipt retention batch');
    for (let index = 0; index < batchNames.length; index++) {
      const artifact = readTreatmentOutcomeReceiptArtifact(
        paths[index]!, batchNames[index]!, assurance.token,
      );
      receipts.push(artifact);
    }
  }
  const retiredByName = new Map((retention?.tombstones ?? []).map((value) => [value.name, value]));
  for (const [name, compacted] of authority.compactedMarkers) {
    retiredByName.set(name, compacted);
  }
  const overlap = receipts.filter((receipt) => retiredByName.has(receipt.name));
  for (const receipt of overlap) {
    if (retiredByName.get(receipt.name)!.receiptDigest !== receipt.receiptDigest) {
      throw new Error('conflicting treatment receipt retention overlap');
    }
  }
  for (let offset = 0; offset < overlap.length; offset += 512) {
    const batch = overlap.slice(offset, offset + 512);
    const paths = batch.map((receipt) => join(dir, receipt.name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe treatment receipt overlap batch');
    for (let index = 0; index < batch.length; index++) {
      const current = readTreatmentOutcomeReceiptArtifact(
        paths[index]!, batch[index]!.name, assurance.token,
      );
      if (current.receiptDigest !== batch[index]!.receiptDigest) {
        throw new Error('mutated treatment receipt retention overlap');
      }
    }
  }
  for (const receipt of overlap) {
    assertStableDispatchProductionWriteRoot();
    unlinkSync(join(dir, receipt.name));
  }
  if (overlap.length > 0) fsyncDirectory(dir);
  const overlapped = new Set(overlap.map((receipt) => receipt.name));
  receipts = receipts.filter((receipt) => !overlapped.has(receipt.name));
  if (retention && receipts.some((receipt) =>
    Date.parse(receipt.ts) <= Date.parse(retention.droppedThrough))) {
    throw new Error('restored retired treatment outcome receipt');
  }
  if (receipts.length < MAX_TREATMENT_OUTCOME_RECEIPTS) return;
  receipts.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.name.localeCompare(right.name));
  const minimumDropCount = receipts.length - MAX_TREATMENT_OUTCOME_RECEIPTS + 1;
  const cutoff = Date.parse(receipts[minimumDropCount - 1]!.ts);
  const dropping = receipts.filter((receipt) => Date.parse(receipt.ts) <= cutoff);
  const droppedThrough = dropping.reduce((latest, receipt) =>
    Date.parse(receipt.ts) > Date.parse(latest) ? receipt.ts : latest, dropping[0]!.ts);
  const nextRetention = writeTreatmentReceiptRetention(dir, retention, droppedThrough, dropping);
  for (let offset = 0; offset < dropping.length; offset += 512) {
    const batch = dropping.slice(offset, offset + 512);
    const paths = batch.map((receipt) => join(dir, receipt.name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe treatment receipt deletion batch');
    for (let index = 0; index < batch.length; index++) {
      const current = readTreatmentOutcomeReceiptArtifact(
        paths[index]!, batch[index]!.name, assurance.token,
      );
      if (current.receiptDigest !== batch[index]!.receiptDigest) {
        throw new Error('mutated treatment outcome receipt during retention');
      }
    }
  }
  for (const receipt of dropping) {
    assertStableDispatchProductionWriteRoot();
    unlinkSync(join(dir, receipt.name));
  }
  fsyncDirectory(dir);
  assertStableDispatchProductionWriteRoot();
  writeTreatmentReceiptProtocolState(dir, treatmentReceiptProtocolFor(nextRetention));
}

export function mergeTreatmentOutcomeReceipts(
  result: DispatchProductionEventsReadResult,
  opts: ReadDispatchProductionEventsOptions,
  cap: number,
  maxBytes: number,
  maxRows: number,
): void {
  // Raw JSONL is analytics only. A terminal treatment witness exists solely as
  // one strict canonical receipt, never because a raw row claims that role.
  result.events = result.events.filter((event) => event.basis !== 'repair-lifecycle-outcome');
  const dir = treatmentOutcomeReceiptDir();
  if (!existsSync(dir)) return;
  const lock = opts.inspectionOnly ? undefined : acquireLocalStoreLock(treatmentReceiptLockPath(), 250);
  if (!opts.inspectionOnly && !lock) {
    result.sourceState = 'degraded';
    result.complete = false;
    result.unreadableFiles++;
    pushStopReason(result.stopReasons, 'io-error');
    return;
  }
  let directorySnapshot: ReturnType<typeof lstatSync> | undefined;
  const entries: string[] = [];
  try {
    const dirStat = lstatSync(dir);
    if (!safeDispatchProductionDirectory(dirStat) ||
      (process.platform !== 'win32' && (dirStat.mode & 0o077) !== 0)) throw new Error('unsafe receipt directory');
    directorySnapshot = dirStat;
    inspectExactReceiptAuthorityDirectory(dir);
    const handle = opendirSync(dir);
    try {
      let physical = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physical++;
        if (physical > MAX_TREATMENT_RECEIPT_DIR_ENTRIES) throw new Error('receipt directory limit');
        if (/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name)) entries.push(entry.name);
      }
    } finally { handle.closeSync(); }
  } catch {
    result.sourceState = 'degraded';
    result.complete = false;
    result.unreadableFiles++;
    pushStopReason(result.stopReasons, 'io-error');
    if (lock) releaseLocalStoreLock(lock);
    return;
  }
  let retention: TreatmentReceiptRetentionState | null = null;
  let compactedMarkers = new Map<string, TreatmentCompactedReceiptMarker>();
  let retiredSources = new Map<string, DispatchProductionEvent>();
  try {
    const retentionPath = join(dir, TREATMENT_RECEIPT_RETENTION_FILE);
    if (existsSync(retentionPath) || existsSync(treatmentReceiptProtocolPath()) ||
      existsSync(treatmentCompactedReceiptDir())) {
      const authority = readTreatmentReceiptAuthorityState();
      retention = authority.retention;
      compactedMarkers = authority.compactedMarkers;
      if (retention) {
        const droppedMs = Date.parse(retention.droppedThrough);
        if (!Number.isFinite(droppedMs)) throw new Error('invalid receipt retention marker');
        if (retention.schemaVersion === 1) {
          retiredSources = readRetiredTreatmentOutcomeSources(retention.droppedThrough);
        }
        if (opts.sinceMs === undefined || opts.sinceMs <= droppedMs) {
          result.complete = false;
          pushStopReason(result.stopReasons, 'file-limit');
        }
      }
    }
  } catch {
    result.complete = false;
    result.unreadableFiles++;
    pushStopReason(result.stopReasons, 'io-error');
    result.sourceState = 'degraded';
    if (lock) releaseLocalStoreLock(lock);
    return;
  }
  const receipts = new Map<string, DispatchProductionEvent>();
  for (const name of entries) {
    if (result.rowsScanned >= maxRows || result.bytesRead >= maxBytes) {
      result.complete = false;
      pushStopReason(result.stopReasons, result.rowsScanned >= maxRows ? 'row-limit' : 'byte-limit');
      break;
    }
    const remaining = Math.min(MAX_TREATMENT_RECEIPT_BYTES, maxBytes - result.bytesRead);
    const path = join(dir, name);
    const loaded = readDispatchProductionFileTail(path, remaining);
    result.filesRead++;
    if (!loaded || loaded.truncated) {
      result.unreadableFiles++;
      result.complete = false;
      pushStopReason(result.stopReasons, 'io-error');
      continue;
    }
    result.bytesRead += loaded.bytesRead;
    result.rowsScanned++;
    try {
      inspectExactReceiptAuthorityFile(path);
      const line = treatmentOutcomeReceiptLine(loaded.text);
      if (line === null) {
        throw new Error('invalid receipt');
      }
      const parsed: unknown = JSON.parse(line);
      if (!canonicalTreatmentOutcomeReceiptEvent(parsed, line, name)) {
        throw new Error('invalid receipt');
      }
      const event = parsed;
      const receiptDigest = treatmentOutcomeReceiptDigest(name, event);
      const tombstone = retention?.tombstones.find((value) => value.name === name);
      const compacted = compactedMarkers.get(name);
      const retired = tombstone ?? compacted;
      if (retired) {
        if (retired.receiptDigest !== receiptDigest) {
          throw new Error('conflicting retired treatment outcome receipt');
        }
        continue;
      }
      const retiredSource = retiredSources.get(name);
      if (retiredSource) {
        if (JSON.stringify(retiredSource) !== JSON.stringify(event)) {
          throw new Error('conflicting retired treatment outcome source');
        }
        continue;
      }
      const eventMs = Date.parse(event.ts);
      if (retention && eventMs <= Date.parse(retention.droppedThrough)) {
        throw new Error('restored retired treatment outcome receipt');
      }
      if (opts.sinceMs !== undefined && eventMs < opts.sinceMs) continue;
      receipts.set(name, withLearningLabelOrigin(event, event.learningLabel, event));
    } catch {
      recordDispatchProductionInvalidReason(result, 'receipt-invalid');
      result.complete = false;
    }
  }
  if (receipts.size > 0) {
    const receiptKeys = new Set(receipts.keys());
    result.events = result.events.filter((event) => {
      const name = treatmentOutcomeReceiptName(event);
      return name === null || !receiptKeys.has(name);
    });
    result.events.push(...receipts.values());
    result.events.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    if (result.events.length > cap) {
      result.events = result.events.slice(0, cap);
      result.complete = false;
      pushStopReason(result.stopReasons, 'event-limit');
    }
  }
  if (!result.complete || result.invalidRows > 0 || result.unreadableFiles > 0) result.sourceState = 'degraded';
  if (opts.inspectionOnly && directorySnapshot) {
    try {
      const directoryAfter = lstatSync(dir);
      if (!safeDispatchProductionDirectory(directoryAfter) ||
        !sameFile(directorySnapshot, directoryAfter) ||
        directorySnapshot.mtimeMs !== directoryAfter.mtimeMs ||
        directorySnapshot.ctimeMs !== directoryAfter.ctimeMs) throw new Error('receipt directory changed');
    } catch {
      result.sourceState = 'degraded';
      result.complete = false;
      result.unreadableFiles++;
      pushStopReason(result.stopReasons, 'io-error');
    }
  }
  if (lock) releaseLocalStoreLock(lock);
}
