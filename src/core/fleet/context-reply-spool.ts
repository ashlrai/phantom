/**
 * Durable spool for context-reply envelopes whose bus publication failed.
 * A saved record is the only state a retry needs: it keeps the exact canonical
 * wire bytes so bus dedupe stays exact, and a retry only republishes — it never
 * authorizes rerunning the worker. The reply body stays untrusted opaque data;
 * nothing here infers task completion or merge authority from it.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, unlinkSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { MAX_BUS_ENVELOPE_BYTES, parseBusEnvelope, validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';
import type { BusInboxOptions } from './bus-inbox.js';
import { publishContextReply, runContextReply, type ContextReplyOptions, type ContextReplyResult } from './context-result-bus.js';
import type { ContextWorkerIO } from './context-worker-run.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';

export const SPOOL_MAX_RECORDS = 64;
/** Canonical wire JSON can be 64 KiB and string escaping at most doubles it. */
export const SPOOL_MAX_RECORD_BYTES = 2 * MAX_BUS_ENVELOPE_BYTES + 1024;
export const SPOOL_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SPOOL_MAX_ENTRIES_SCAN = 2048;
const RECORD_PATTERN = /^reply-[0-9a-f]{32}\.json$/;
const LOCK_WAIT_MS = 500;

export interface SpooledWorkerExit { status: 'returned'; exitCode: number }
export interface PendingContextReply { reply: BusEnvelope; preparedAt: number; workerExit: SpooledWorkerExit }
export type ContextDeliveryStatus =
  | 'posted' | 'duplicate' | 'pending'
  | 'unavailable' | 'retryable' | 'full' | 'conflict' | 'invalid' | 'expired' | 'not-attempted'
  | 'unsafe' | 'missing' | 'corrupt' | 'clock-rollback' | 'spool-failed';
export interface ContextDeliveryOutcome { status: ContextDeliveryStatus; record?: string }
export interface ContextDeliverRunResult {
  workerExit: ContextReplyResult['workerExit'];
  delivery: ContextDeliveryOutcome;
  exitCode: number;
}
export interface ContextDeliverRetryResult {
  workerExit: SpooledWorkerExit | { status: 'unknown' };
  delivery: ContextDeliveryOutcome;
  exitCode: number;
}

function safeDirectoryStat(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
    (process.platform === 'win32' || (stat.mode & 0o777) === 0o700);
}
function safeRecordStat(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0);
}

/** The spool directory is explicit, private, owner-only, and ACL-clean. */
function assertSpoolDirectory(dir: string, create: boolean): void {
  if (!isAbsolute(dir) || dir.includes('\0')) throw new Error('unsafe spool directory');
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!safeDirectoryStat(lstatSync(dir)) ||
    !assurePrivateStoragePath(dir, 'directory', 'inspect-existing', { anchorPath: dirname(dir) }).ok) {
    throw new Error('unsafe spool directory');
  }
}

/** Deterministic, filesystem-safe record name; never interpolates the raw id. */
export function contextReplyRecordPath(spoolDir: string, replyId: string): string | null {
  if (typeof replyId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(replyId)) return null;
  const hash = createHash('sha256').update(replyId, 'utf8').digest('hex').slice(0, 32);
  return join(spoolDir, `reply-${hash}.json`);
}

/** Counted and byte usage over record names only; bounded scan, conservative cap. */
function spoolUsage(dir: string): { count: number; bytes: number } {
  const names = readdirSync(dir);
  if (names.length > SPOOL_MAX_ENTRIES_SCAN) return { count: SPOOL_MAX_RECORDS, bytes: SPOOL_MAX_TOTAL_BYTES };
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!RECORD_PATTERN.test(name)) continue;
    count += 1;
    try { const stat = lstatSync(join(dir, name)); if (stat.isFile()) bytes += Number(stat.size); } catch { /* changing dir */ }
  }
  return { count, bytes };
}

function removeRecordFile(path: string, dir: string): boolean {
  try {
    if (!safeRecordStat(lstatSync(path))) return false;
    unlinkSync(path);
    fsyncDirectory(dir);
    return true;
  } catch { return false; }
}

function dropRecordIfUncontended(path: string, dir: string): void {
  const acquired = acquireLocalStoreLockWithOutcome(join(dir, 'writer.lock'), 0, { anchorPath: dir, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') return;
  try { removeRecordFile(path, dir); } finally { releaseLocalStoreLock(acquired.lock); }
}

/** Persist the exact reply envelope for later delivery; never rewrites wire bytes. */
export function savePendingContextReply(spoolDir: string, pending: PendingContextReply): 'saved' | 'full' | 'invalid' | 'unavailable' {
  if (!Number.isSafeInteger(pending.preparedAt) || pending.preparedAt < 0 ||
    pending.workerExit.status !== 'returned' ||
    !Number.isSafeInteger(pending.workerExit.exitCode) || pending.workerExit.exitCode < 0 || pending.workerExit.exitCode > 255) return 'invalid';
  const checked = validateBusEnvelope(pending.reply);
  if (!checked.ok) return 'invalid';
  const path = contextReplyRecordPath(spoolDir, checked.value.id);
  if (path === null) return 'invalid';
  const record = JSON.stringify({ version: 1, wire: checked.json, preparedAt: pending.preparedAt, workerExit: pending.workerExit });
  if (Buffer.byteLength(record, 'utf8') > SPOOL_MAX_RECORD_BYTES) return 'invalid';
  try {
    assertSpoolDirectory(spoolDir, true);
    const acquired = acquireLocalStoreLockWithOutcome(join(spoolDir, 'writer.lock'), LOCK_WAIT_MS, { anchorPath: spoolDir, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') return 'unavailable';
    try {
      const usage = spoolUsage(spoolDir);
      let exists = false;
      try { exists = safeRecordStat(lstatSync(path)); } catch { /* absent or unsafe name still counts as new */ }
      if (!exists && (usage.count >= SPOOL_MAX_RECORDS || usage.bytes >= SPOOL_MAX_TOTAL_BYTES)) return 'full';
      const temporary = join(spoolDir, `.${basename(path)}.tmp`);
      try { if (safeRecordStat(lstatSync(temporary))) unlinkSync(temporary); } catch { /* no stale temp */ }
      writePrivateFileAtomically(temporary, path, record, { anchorPath: spoolDir, label: 'Context reply spool record' });
      return 'saved';
    } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { return 'unavailable'; }
}

function parseRecord(text: string): PendingContextReply | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'preparedAt,version,wire,workerExit') return null;
  const record = value as { version: unknown; wire: unknown; preparedAt: unknown; workerExit: unknown };
  if (record.version !== 1 || typeof record.wire !== 'string' ||
    Buffer.byteLength(record.wire, 'utf8') > MAX_BUS_ENVELOPE_BYTES ||
    !Number.isSafeInteger(record.preparedAt) || (record.preparedAt as number) < 0) return null;
  const exit = record.workerExit;
  if (exit === null || typeof exit !== 'object' || Array.isArray(exit) ||
    Object.keys(exit).sort().join(',') !== 'exitCode,status' ||
    (exit as SpooledWorkerExit).status !== 'returned' ||
    !Number.isSafeInteger((exit as SpooledWorkerExit).exitCode) ||
    (exit as SpooledWorkerExit).exitCode < 0 || (exit as SpooledWorkerExit).exitCode > 255) return null;
  const checked = parseBusEnvelope(record.wire);
  // Only canonical wire bytes keep bus dedupe exact.
  if (!checked.ok || checked.json !== record.wire) return null;
  return { reply: checked.value, preparedAt: record.preparedAt as number, workerExit: exit as SpooledWorkerExit };
}

/** Republish one explicit spool record. Only `publishContextReply` runs: the
 * worker is never re-executed, and age is measured on the wall clock so the
 * original wire TTL keeps shrinking across restarts and can never extend. */
export function deliverSpooledContextReply(recordPath: string, bus: BusInboxOptions = {}): ContextDeliverRetryResult {
  const refuse = (status: ContextDeliveryStatus, exitCode: number,
    workerExit: ContextDeliverRetryResult['workerExit'] = { status: 'unknown' }): ContextDeliverRetryResult =>
    ({ workerExit, delivery: { status }, exitCode });
  if (!isAbsolute(recordPath) || recordPath.includes('\0') || !RECORD_PATTERN.test(basename(recordPath))) {
    return refuse('invalid', 2);
  }
  const dir = dirname(recordPath);
  try { assertSpoolDirectory(dir, false); } catch { return refuse('unsafe', 2); }
  const acquired = acquireLocalStoreLockWithOutcome(join(dir, 'writer.lock'), 0, { anchorPath: dir, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') return refuse('retryable', 1);
  try {
    let named: Stats;
    try { named = lstatSync(recordPath); }
    catch (error) { return refuse((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe', 2); }
    if (!safeRecordStat(named)) return refuse('unsafe', 2);
    const read = readStableRegularFile(recordPath, { anchorPath: dir, maxFileBytes: SPOOL_MAX_RECORD_BYTES, remainingBytes: SPOOL_MAX_RECORD_BYTES });
    if (!read.ok || read.text.includes('\ufffd')) return refuse('corrupt', 2);
    const pending = parseRecord(read.text);
    // A record is bound to its deterministic name; mismatches mean tampering.
    if (pending === null) return refuse('corrupt', 2);
    const expected = contextReplyRecordPath(dir, pending.reply.id);
    if (expected === null || basename(expected) !== basename(recordPath)) {
      return refuse('corrupt', 2);
    }
    const now = (bus.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < pending.preparedAt) return refuse('clock-rollback', 2, pending.workerExit);
    const elapsed = now - pending.preparedAt;
    if (elapsed >= pending.reply.ttl) return refuse('expired', 2, pending.workerExit);
    const receipt = publishContextReply(pending.reply, elapsed, bus);
    if (receipt.status === 'posted' || receipt.status === 'duplicate') {
      removeRecordFile(recordPath, dir);
      return { workerExit: pending.workerExit, delivery: { status: receipt.status }, exitCode: 0 };
    }
    const retryable = receipt.status === 'unavailable' || receipt.status === 'retryable';
    return refuse(receipt.status, retryable ? 1 : 2, pending.workerExit);
  } finally { releaseLocalStoreLock(acquired.lock); }
}

/** Run the worker exactly once; on failed publication durably spool the exact
 * envelope, its preparation time and the worker outcome before returning. */
export async function runContextReplyDelivery(
  opts: ContextReplyOptions & { spoolDir: string },
  io: ContextWorkerIO = {},
  bus: BusInboxOptions = {},
): Promise<ContextDeliverRunResult> {
  // Refuse before launching: a reply that cannot be durably preserved must
  // never be produced, and an unusable spool directory is an operator error.
  const record = contextReplyRecordPath(opts.spoolDir, opts.replyId);
  if (record === null) {
    return { workerExit: { status: 'not-started' }, delivery: { status: 'invalid' }, exitCode: 2 };
  }
  try { assertSpoolDirectory(opts.spoolDir, true); }
  catch { return { workerExit: { status: 'not-started' }, delivery: { status: 'unsafe' }, exitCode: 2 }; }
  const result = await runContextReply(opts, io, bus);
  if (result.reply === null) {
    return { workerExit: result.workerExit, delivery: { status: result.replyReceipt.status }, exitCode: result.exitCode };
  }
  if (result.replyReceipt.status === 'posted' || result.replyReceipt.status === 'duplicate') {
    dropRecordIfUncontended(record, opts.spoolDir);
    return { workerExit: result.workerExit, delivery: { status: result.replyReceipt.status }, exitCode: result.exitCode };
  }
  const exitCode = result.workerExit.status === 'returned' ? result.workerExit.exitCode : result.exitCode;
  const saved = savePendingContextReply(opts.spoolDir, {
    reply: result.reply, preparedAt: Date.now(), workerExit: { status: 'returned', exitCode },
  });
  return {
    workerExit: result.workerExit,
    delivery: { status: saved === 'saved' ? 'pending' : 'spool-failed', ...(saved === 'saved' ? { record } : {}) },
    exitCode: result.exitCode || 1,
  };
}
