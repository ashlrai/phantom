/** Stable ledger storage, authority locks, and bounded partition reads. */

import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  type Stats,
  lstatSync,
  realpathSync,
  fstatSync,
  existsSync,
  mkdirSync,
  constants as fsConstants,
  openSync,
  closeSync,
  chmodSync,
  readSync,
  writeSync,
  fsyncSync,
  type BigIntStats,
} from 'node:fs';
import { assurePrivateStoragePath } from '../../util/private-storage.js';
import { fsyncDirectory } from '../../util/durability.js';
import {
  ATTEMPT_PROOF_RECEIPT_DIR,
  SHA256_RE,
  HARD_READ_MAX_BYTES,
  HARD_READ_MAX_ROWS,
  MAX_READ_ROW_BYTES,
} from './constants.js';
import type {
  DispatchProductionEvent,
  DispatchProductionSourceQuality,
  DispatchProductionEventsReadResult,
  DispatchProductionInvalidReasonCode,
  DispatchProductionReadStopReason,
  DispatchProductionParentIdentity,
  DispatchProductionParentStatus,
} from './types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../local-store-lock.js';
import { dispatchProductionLedgerRetentionHooksForTest } from './retention-hooks.js';
import {
  canonicalStoredDispatchProductionEvent,
  storedDispatchProductionIdentities,
} from './attempt-proofs.js';
import { canonicalDispatchRepoIdentity } from './events.js';

export function dispatchProductionDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== ''
      ? configuredHome
      : join(homedir(), '.ashlr');
  return join(root, 'dispatch-production');
}

interface DispatchProductionWriteRoot {
  path: string;
  realPath: string;
  identity: Stats;
  fd?: number;
}

const dispatchProductionWriteRoots: DispatchProductionWriteRoot[] = [];

export function assertStableDispatchProductionWriteRoot(): DispatchProductionWriteRoot {
  const expected = dispatchProductionWriteRoots.at(-1);
  if (!expected) throw new Error('dispatch production write root unavailable');
  const named = lstatSync(expected.path);
  if (!safeDispatchProductionDirectory(named) || !sameFile(expected.identity, named) ||
    realpathSync(expected.path) !== expected.realPath) {
    throw new Error('dispatch production write root changed');
  }
  if (expected.fd !== undefined) {
    const opened = fstatSync(expected.fd);
    if (!safeDispatchProductionDirectory(opened) || !sameFile(expected.identity, opened)) {
      throw new Error('dispatch production write root changed');
    }
  }
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    expected.path, 'directory', 'inspect-owned', { anchorPath: dirname(expected.path) },
  ).ok) throw new Error('unsafe Windows dispatch production root');
  return expected;
}

function openDispatchProductionWriteRoot(): DispatchProductionWriteRoot {
  const path = dispatchProductionDir();
  const parent = dirname(path);
  let created = false;
  let fd: number | undefined;
  try {
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      created = true;
    }
    const before = lstatSync(path);
    if (!safeDispatchProductionDirectory(before)) {
      throw new Error('unsafe dispatch production write root');
    }
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path, 'directory', created ? 'secure-created' : 'inspect-owned', { anchorPath: parent },
    ).ok) throw new Error('unsafe Windows dispatch production root');
    const identity = lstatSync(path);
    const realParent = realpathSync(parent);
    const realPath = realpathSync(path);
    if (!safeDispatchProductionDirectory(identity) || !sameFile(before, identity) ||
      dirname(realPath) !== realParent || basename(realPath) !== basename(path)) {
      throw new Error('unsafe dispatch production write root');
    }
    if (process.platform !== 'win32') {
      const directoryOnly = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | directoryOnly);
      const opened = fstatSync(fd);
      if (!safeDispatchProductionDirectory(opened) || !sameFile(identity, opened)) {
        throw new Error('dispatch production write root changed');
      }
    }
    if (created) fsyncDirectory(parent);
    return { path, realPath, identity, ...(fd === undefined ? {} : { fd }) };
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    throw error;
  }
}

export function withStableDispatchProductionWriteRoot<T>(consume: () => T): T {
  if (dispatchProductionWriteRoots.length > 0) {
    assertStableDispatchProductionWriteRoot();
    const value = consume();
    assertStableDispatchProductionWriteRoot();
    return value;
  }
  const root = openDispatchProductionWriteRoot();
  dispatchProductionWriteRoots.push(root);
  try {
    assertStableDispatchProductionWriteRoot();
    const value = consume();
    assertStableDispatchProductionWriteRoot();
    return value;
  } finally {
    dispatchProductionWriteRoots.pop();
    if (root.fd !== undefined) { try { closeSync(root.fd); } catch { /* best effort */ } }
  }
}

export function treatmentOutcomeReceiptDir(): string {
  return join(dispatchProductionDir(), 'repair-treatment-outcomes');
}

export function attemptProofReceiptDir(): string {
  return join(dispatchProductionDir(), ATTEMPT_PROOF_RECEIPT_DIR);
}

export function attemptProofReceiptName(generationId: string, ordinal: 1 | 2): string {
  return `${generationId}-${ordinal}.json`;
}

export function attemptFailureReceiptName(
  generationId: string,
  ordinal: 1 | 2,
  attemptHash: string,
): string {
  return `${generationId}-${ordinal}-${attemptHash}.failure.json`;
}

export function attemptReceiptLockPath(): string {
  return join(attemptProofReceiptDir(), '.receipts.lock');
}

export function ensurePrivateReceiptDirectory(dir: string): void {
  assertStableDispatchProductionWriteRoot();
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: false, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (!safeDispatchProductionDirectory(dirStat)) throw new Error('unsafe receipt directory');
  chmodSync(dir, 0o700);
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    dir, 'directory', created ? 'secure-created' : 'inspect-existing', {
      anchorPath: dispatchProductionDir(),
    },
  ).ok) throw new Error('unsafe Windows receipt directory');
  if (created) fsyncDirectory(dirname(dir));
  assertStableDispatchProductionWriteRoot();
}

export function secureCreatedReceiptTempFile(path: string): void {
  assertStableDispatchProductionWriteRoot();
  if (!/(?:\.\d+\.tmp|\.[a-f0-9]{32}\.stage)$/.test(basename(path))) {
    throw new Error('receipt secure-created target is not a new temp');
  }
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    path, 'file', 'secure-created', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('unsafe Windows receipt file');
}

export function inspectExactReceiptAuthorityFile(path: string): void {
  if (dispatchProductionWriteRoots.length > 0) assertStableDispatchProductionWriteRoot();
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('unsafe Windows receipt authority file');
}

export class ReceiptDirectoryAuthorityError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe Windows receipt authority directory: ${reason}`);
  }
}

export const UNSAFE_RECEIPT_DIRECTORY_REASONS = new Set([
  'anchor-not-reached', 'dacl-not-protected', 'deny-ace', 'inherited-ace',
  'missing-or-duplicate-principal', 'reparse-ancestor', 'reparse-point',
  'unexpected-ace-count', 'untrusted-ancestor-delete', 'untrusted-ancestor-owner',
  'untrusted-item-write', 'wrong-flags', 'wrong-kind', 'wrong-owner', 'wrong-rights',
]);

export function inspectExactReceiptAuthorityDirectory(path: string): void {
  if (process.platform !== 'win32') return;
  const assurance = assurePrivateStoragePath(
    path, 'directory', 'inspect-existing', { anchorPath: dispatchProductionDir() },
  );
  if (!assurance.ok) throw new ReceiptDirectoryAuthorityError(assurance.reason);
}

export function treatmentOutcomeReceiptName(event: DispatchProductionEvent): string | null {
  if (
    event.basis !== 'repair-lifecycle-outcome' ||
    !event.repairGenerationId || !SHA256_RE.test(event.repairGenerationId) ||
    !event.repairTreatmentAttemptHash || !SHA256_RE.test(event.repairTreatmentAttemptHash)
  ) return null;
  return `${event.repairGenerationId}-${event.repairTreatmentAttemptHash}.json`;
}

const heldAttemptAuthorityLocks = new Set<string>();

function attemptAuthorityLockPath(generationId: string): string {
  return join(dispatchProductionDir(), `.attempt-authority-${generationId}.lock`);
}

export function withDispatchProductionGenerationAuthority<T>(
  generationId: string,
  consume: () => T,
): { ok: true; value: T } | { ok: false } {
  // Global order: lifecycle -> generation -> receipt writer -> date partition.
  // No dispatch writer may acquire lifecycle authority while holding this lock.
  if (!SHA256_RE.test(generationId)) return { ok: false };
  if (heldAttemptAuthorityLocks.has(generationId)) return { ok: true, value: consume() };
  let openedRoot: DispatchProductionWriteRoot | undefined;
  if (dispatchProductionWriteRoots.length === 0) {
    try {
      openedRoot = openDispatchProductionWriteRoot();
      dispatchProductionWriteRoots.push(openedRoot);
    } catch {
      return { ok: false };
    }
  }
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    assertStableDispatchProductionWriteRoot();
    lock = acquireLocalStoreLock(attemptAuthorityLockPath(generationId));
    assertStableDispatchProductionWriteRoot();
  } catch {
    releaseLocalStoreLock(lock);
    lock = null;
  }
  if (!lock) {
    if (openedRoot) {
      dispatchProductionWriteRoots.pop();
      if (openedRoot.fd !== undefined) {
        try { closeSync(openedRoot.fd); } catch { /* best effort */ }
      }
    }
    return { ok: false };
  }
  heldAttemptAuthorityLocks.add(generationId);
  try {
    const value = consume();
    assertStableDispatchProductionWriteRoot();
    return { ok: true, value };
  } finally {
    heldAttemptAuthorityLocks.delete(generationId);
    releaseLocalStoreLock(lock);
    if (openedRoot) {
      dispatchProductionWriteRoots.pop();
      if (openedRoot.fd !== undefined) {
        try { closeSync(openedRoot.fd); } catch { /* best effort */ }
      }
    }
  }
}

export function appendDispatchProductionLine(path: string, line: string): void {
  assertStableDispatchProductionWriteRoot();
  const lock = acquireLocalStoreLock(`${path}.lock`);
  if (!lock) throw new Error('dispatch production ledger lock unavailable');
  let fd: number | undefined;
  try {
    assertStableDispatchProductionWriteRoot();
    const existed = existsSync(path);
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!safeDispatchProductionFile(opened)) throw new Error('dispatch production ledger is not a safe regular file');
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      const read = readSync(fd, tail, 0, 1, opened.size - 1);
      if (read !== 1) throw new Error('dispatch production ledger tail is unreadable');
      if (tail[0] !== 0x0a && writeSync(fd, '\n', undefined, 'utf8') !== 1) {
        throw new Error('dispatch production ledger separator write was short');
      }
    }
    if (writeSync(fd, line, undefined, 'utf8') !== Buffer.byteLength(line)) {
      throw new Error('dispatch production ledger append was short');
    }
    fsyncSync(fd);
    assertStableDispatchProductionWriteRoot();
    if (!existed) {
      fsyncDirectory(dirname(path));
    }
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    releaseLocalStoreLock(lock);
  }
}

export function boundedReadOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

export function emptyDispatchProductionRead(
  sourceState: DispatchProductionSourceQuality['sourceState'],
  overrides: Partial<DispatchProductionEventsReadResult> = {},
): DispatchProductionEventsReadResult {
  return {
    events: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    datedFilesRead: 0,
    looseFilesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
    invalidReasonCounts: [],
    ...overrides,
  };
}

export function recordDispatchProductionInvalidReason(
  result: DispatchProductionEventsReadResult,
  reason: DispatchProductionInvalidReasonCode,
): void {
  result.invalidRows++;
  const counts = result.invalidReasonCounts ??= [];
  const existing = counts.find((entry) => entry.reason === reason);
  if (existing) existing.count++;
  else counts.push({ reason, count: 1 });
}

export function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function safeDispatchProductionDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() &&
    (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid()) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

export function safeDispatchProductionFile(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && Number(stat.nlink) === 1 &&
    (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid()) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function safeDispatchProductionBigIntFile(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n &&
    (process.platform === 'win32' || typeof process.getuid !== 'function' ||
      stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function sameBigIntFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid && left.gid === right.gid &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function readDispatchProductionFileTail(
  path: string,
  maxBytes: number,
): { text: string; bytesRead: number; truncated: boolean } | null {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path, { bigint: true });
    if (!safeDispatchProductionBigIntFile(pathBefore)) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(fd, { bigint: true });
    if (!safeDispatchProductionBigIntFile(before) || !sameBigIntFileSnapshot(pathBefore, before)) return null;
    const fileSize = Number(before.size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) return null;
    const bytes = Math.min(fileSize, maxBytes);
    const start = Math.max(0, fileSize - bytes);
    const readPass = (): Buffer | null => {
      const buffer = Buffer.alloc(bytes);
      let offset = 0;
      while (offset < bytes) {
        const count = readSync(fd!, buffer, offset, bytes - offset, start + offset);
        if (count <= 0) return null;
        offset += count;
      }
      return buffer;
    };
    const buffer = readPass();
    if (buffer === null) return null;
    dispatchProductionLedgerRetentionHooksForTest?.afterDispatchReadPass?.(path);
    const between = fstatSync(fd, { bigint: true });
    const pathBetween = lstatSync(path, { bigint: true });
    if (!sameBigIntFileSnapshot(before, between) || !sameBigIntFileSnapshot(between, pathBetween)) return null;
    const verification = readPass();
    if (verification === null || !buffer.equals(verification)) return null;
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !safeDispatchProductionBigIntFile(pathAfter) ||
      !safeDispatchProductionBigIntFile(after) ||
      !sameBigIntFileSnapshot(before, after) ||
      !sameBigIntFileSnapshot(after, pathAfter)
    ) return null;
    const bytesRead = buffer.length;
    let text: string;
    if (start > 0) {
      const boundaryWasNewline = buffer[0] === 0x0a;
      text = buffer.subarray(1, bytesRead).toString('utf8');
      if (!boundaryWasNewline) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
    } else {
      text = buffer.subarray(0, bytesRead).toString('utf8');
    }
    return { text, bytesRead, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort diagnostics read */ }
    }
  }
}

export function pushStopReason(
  reasons: DispatchProductionReadStopReason[],
  reason: DispatchProductionReadStopReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Authority-specific parent lookup. It reads only the dated partitions named
 * by the requested identities, so unrelated history growth cannot revoke a
 * valid repair handoff through the observational reader's global caps.
 */
export function readDispatchProductionParents(
  targets: readonly DispatchProductionParentIdentity[],
): DispatchProductionParentStatus[] {
  const statuses = targets.map((): DispatchProductionParentStatus => 'missing');
  const byDate = new Map<string, number[]>();
  const canonicalRepos = new Map<string, string | null>();
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const parsed = Date.parse(target.ts);
    if (!Number.isFinite(parsed)) {
      statuses[index] = 'degraded';
      continue;
    }
    const date = new Date(parsed).toISOString().slice(0, 10);
    const indices = byDate.get(date) ?? [];
    indices.push(index);
    byDate.set(date, indices);
  }
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return statuses;
  let directoryBefore: Stats;
  try {
    directoryBefore = lstatSync(dir);
    if (!safeDispatchProductionDirectory(directoryBefore)) throw new Error('unsafe parent directory');
  } catch {
    return statuses.map(() => 'degraded');
  }
  for (const [date, indices] of byDate) {
    const path = join(dir, `${date}.jsonl`);
    if (!existsSync(path)) continue;
    const loaded = readDispatchProductionFileTail(path, HARD_READ_MAX_BYTES);
    if (!loaded) {
      for (const index of indices) statuses[index] = 'degraded';
      continue;
    }
    const complete = loaded.text.endsWith('\n');
    const lines = complete
      ? loaded.text.slice(0, -1).split('\n')
      : loaded.text.split('\n').slice(0, -1);
    const eventsByIdentity = new Map<string, Map<string, DispatchProductionEvent>>();
    const invalidIdentities = new Set<string>();
    let partitionInvalid = !complete || loaded.truncated || lines.length > HARD_READ_MAX_ROWS;
    for (const line of lines.slice(0, HARD_READ_MAX_ROWS)) {
      if (!line.trim()) {
        partitionInvalid = true;
        continue;
      }
      if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
        partitionInvalid = true;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (!canonicalStoredDispatchProductionEvent(parsed, line, date)) {
          const identities = storedDispatchProductionIdentities(parsed, line, date);
          if (identities === null) partitionInvalid = true;
          else for (const identity of identities) invalidIdentities.add(identity);
          continue;
        }
        const key = JSON.stringify([
          parsed.ts, parsed.itemId, parsed.repo, parsed.outcome,
          parsed.trajectoryId ?? parsed.runId ?? null,
        ]);
        const semantic = eventsByIdentity.get(key) ?? new Map<string, DispatchProductionEvent>();
        semantic.set(JSON.stringify(parsed), parsed);
        eventsByIdentity.set(key, semantic);
      } catch {
        partitionInvalid = true;
      }
    }
    for (const index of indices) {
      if (partitionInvalid) {
        statuses[index] = 'degraded';
        continue;
      }
      const target = targets[index]!;
      let targetRepo = canonicalRepos.get(target.repo);
      if (targetRepo === undefined) {
        targetRepo = canonicalDispatchRepoIdentity(target.repo);
        canonicalRepos.set(target.repo, targetRepo);
      }
      if (targetRepo === null) {
        statuses[index] = 'degraded';
        continue;
      }
      const targetIdentity = JSON.stringify([
        target.ts, target.itemId, targetRepo, target.outcome, target.attemptId,
      ]);
      if (invalidIdentities.has(targetIdentity)) {
        statuses[index] = 'degraded';
        continue;
      }
      const semanticEvents = [...(eventsByIdentity.get(targetIdentity)?.values() ?? [])];
      if (semanticEvents.length > 1) {
        statuses[index] = 'degraded';
        continue;
      }
      const event = semanticEvents[0];
      const found = event !== undefined &&
        (target.source === undefined || event.source === target.source) &&
        (target.backend === undefined || event.backend === target.backend) &&
        (target.tier === undefined || event.tier === target.tier) &&
        (target.objectiveHash === undefined || event.objectiveHash === target.objectiveHash);
      statuses[index] = found
        ? 'found'
        : 'missing';
    }
  }
  try {
    const directoryAfter = lstatSync(dir);
    if (
      !safeDispatchProductionDirectory(directoryAfter) ||
      !sameFile(directoryBefore, directoryAfter) ||
      directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
      directoryBefore.ctimeMs !== directoryAfter.ctimeMs
    ) {
      return statuses.map(() => 'degraded');
    }
  } catch {
    return statuses.map(() => 'degraded');
  }
  return statuses;
}
