/** Bounded local transport only. Bodies are untrusted data, never dispatched. */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';

export const BUS_INBOX_MAX_BYTES = 1024 * 1024;
export const BUS_INBOX_MAX_MESSAGES = 1024;
export const BUS_INBOX_MAX_READ = 100;
export interface BusInboxOptions { root?: string; now?: () => number }
export interface BusInboxReceipt { cursor: number; receivedAt: number; envelope: BusEnvelope }
export interface BusInboxInspection {
  source: 'missing' | 'available' | 'unavailable';
  retainedCount: number | null;
  retainedBytes: number | null;
  maxMessages: number;
  maxBytes: number;
  liveCount: number | null;
  expiredCount: number | null;
}
type Failure = { status: 'invalid' | 'unavailable' | 'retryable' | 'full' | 'conflict' };
export type BusInboxPost = Failure | { status: 'posted' | 'duplicate'; id: string; cursor: number };
export type BusInboxPage = Failure | { status: 'ok'; messages: BusInboxReceipt[]; nextCursor: number };
function rootPath(options: BusInboxOptions): string { return options.root ?? join(ashlrHome(), 'fleet'); }
function privatePath(path: string, kind: 'file' | 'directory', anchorPath: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o777) !== (kind === 'file' ? 0o600 : 0o700))) throw new Error('Unavailable');
  if (!assurePrivateStoragePath(path, kind, 'inspect-existing', { anchorPath }).ok) throw new Error('Unavailable');
}
function missing(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw new Error('Unavailable'); }
}
/** Snapshot version 2 keeps a monotonic high-water cursor beside sparse rows. */
const BUS_INBOX_SNAPSHOT_VERSION = 2;
interface BusInboxStore {
  source: 'missing' | 'available';
  rows: BusInboxReceipt[];
  /** Greatest cursor ever assigned; 0 while nothing has been posted. */
  highWater: number;
  bytes: number | null;
}
function checkedRow(row: BusInboxReceipt, ids: Set<string>): BusInboxReceipt {
  if (!row || Object.keys(row).sort().join() !== 'cursor,envelope,receivedAt' ||
    !Number.isSafeInteger(row.cursor) || row.cursor < 1 ||
    !Number.isSafeInteger(row.receivedAt) || row.receivedAt < 0) throw new Error('Unavailable');
  const checked = validateBusEnvelope(row.envelope);
  if (!checked.ok || ids.has(checked.value.id)) throw new Error('Unavailable');
  ids.add(checked.value.id);
  return { cursor: row.cursor, receivedAt: row.receivedAt, envelope: checked.value };
}
function loadSnapshot(root: string): BusInboxStore {
  const directory = join(root, 'bus-inbox'), file = join(directory, 'messages.json');
  const absent: BusInboxStore = { source: 'missing', rows: [], highWater: 0, bytes: null };
  if (missing(root)) return absent;
  privatePath(root, 'directory', root);
  if (missing(directory)) return absent;
  privatePath(directory, 'directory', root);
  if (missing(file)) return absent;
  privatePath(file, 'file', root);
  const read = readStableRegularFile(file, { anchorPath: root, maxFileBytes: BUS_INBOX_MAX_BYTES, remainingBytes: BUS_INBOX_MAX_BYTES });
  if (!read.ok) throw new Error('Unavailable');
  const snapshot: unknown = JSON.parse(read.text);
  const ids = new Set<string>();
  if (Array.isArray(snapshot)) {
    // Version 1 stored a bare receipt array whose dense ordinal cursors imply
    // the high-water mark. Reads migrate in memory only; the next append
    // rewrites version 2 atomically.
    if (snapshot.length > BUS_INBOX_MAX_MESSAGES) throw new Error('Unavailable');
    const rows = snapshot.map((row: BusInboxReceipt, index) => {
      if (!row || row.cursor !== index + 1) throw new Error('Unavailable');
      return checkedRow(row, ids);
    });
    return { source: 'available', rows, highWater: rows.length, bytes: read.bytesRead };
  }
  if (snapshot === null || typeof snapshot !== 'object' ||
    Object.keys(snapshot).sort().join() !== 'highWater,rows,version' ||
    (snapshot as { version: unknown }).version !== BUS_INBOX_SNAPSHOT_VERSION ||
    !Number.isSafeInteger((snapshot as { highWater: unknown }).highWater) ||
    (snapshot as { highWater: number }).highWater < 0) throw new Error('Unavailable');
  const { highWater, rows: stored } = snapshot as { highWater: number; rows: unknown };
  if (!Array.isArray(stored) || stored.length > BUS_INBOX_MAX_MESSAGES) throw new Error('Unavailable');
  let ceiling = 0;
  const rows = stored.map((row: BusInboxReceipt) => {
    const receipt = checkedRow(row, ids);
    if (receipt.cursor <= ceiling || receipt.cursor > highWater) throw new Error('Unavailable');
    ceiling = receipt.cursor;
    return receipt;
  });
  return { source: 'available', rows, highWater, bytes: read.bytesRead };
}

/** Observe retained capacity without creating or changing the store. Counts are
 * unknown for missing/unavailable stores; an invalid clock only hides TTL counts. */
export function inspectBusInbox(options: BusInboxOptions = {}): BusInboxInspection {
  const unknown: BusInboxInspection = {
    source: 'unavailable', retainedCount: null, retainedBytes: null,
    maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: BUS_INBOX_MAX_BYTES,
    liveCount: null, expiredCount: null,
  };
  try {
    const snapshot = loadSnapshot(rootPath(options));
    if (snapshot.source === 'missing') return { ...unknown, source: 'missing' };
    const result: BusInboxInspection = {
      ...unknown, source: 'available', retainedCount: snapshot.rows.length, retainedBytes: snapshot.bytes,
    };
    let now: number;
    try { now = (options.now ?? Date.now)(); } catch { return result; }
    if (!Number.isSafeInteger(now) || now < 0) return result;
    const liveCount = snapshot.rows.filter(row => Math.max(0, now - row.receivedAt) < row.envelope.ttl).length;
    return { ...result, liveCount, expiredCount: snapshot.rows.length - liveCount };
  } catch { return unknown; }
}
/** Atomic bounded snapshot: cursors never reset or reuse, and a live receipt is
 * never evicted for another. Under the writer lock, receipts proven expired at
 * the supplied clock are reclaimed before admission; retained receipts keep
 * their original cursor and receivedAt. Dedupe IDs are checked against the
 * pre-pruning snapshot, so an expired retained ID still returns duplicate or
 * conflict in that transaction; once a later append reclaims it, the ID is a
 * fresh post rather than an eternal exactly-once receipt. */
export function appendBusInbox(input: unknown, options: BusInboxOptions = {}): BusInboxPost {
  const checked = validateBusEnvelope(input);
  if (!checked.ok) return { status: 'invalid' };
  try {
    const root = rootPath(options), directory = join(root, 'bus-inbox');
    if (!options.root) { ensurePrivateDirectory(ashlrHome()); privatePath(ashlrHome(), 'directory', ashlrHome()); }
    ensurePrivateDirectory(root); privatePath(root, 'directory', root);
    ensurePrivateDirectory(directory); privatePath(directory, 'directory', root);
    const acquired = acquireLocalStoreLockWithOutcome(join(directory, 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') return { status: acquired.state === 'contended' ? 'retryable' : 'unavailable' };
    try {
      const snapshot = loadSnapshot(root);
      const previous = snapshot.rows.find(row => row.envelope.id === checked.value.id);
      if (previous) return JSON.stringify(previous.envelope) === checked.json
        ? { status: 'duplicate', id: checked.value.id, cursor: previous.cursor } : { status: 'conflict' };
      const receivedAt = (options.now ?? Date.now)();
      if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) return { status: 'invalid' };
      const rows = snapshot.rows.filter(row => Math.max(0, receivedAt - row.receivedAt) < row.envelope.ttl);
      const cursor = snapshot.highWater + 1;
      if (!Number.isSafeInteger(cursor)) return { status: 'full' };
      rows.push({ cursor, receivedAt, envelope: checked.value });
      const json = JSON.stringify({ version: BUS_INBOX_SNAPSHOT_VERSION, highWater: cursor, rows });
      if (rows.length > BUS_INBOX_MAX_MESSAGES || Buffer.byteLength(json) > BUS_INBOX_MAX_BYTES) return { status: 'full' };
      writePrivateFileAtomically(join(directory, '.pending'), join(directory, 'messages.json'), json, { anchorPath: root, label: 'Bus inbox' });
      return { status: 'posted', id: checked.value.id, cursor };
    } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { return { status: 'unavailable' }; }
}
/** nextCursor advances over expired records, including an entirely expired page.
 * Scan is capped at 1 MiB / 1024 retained records; output at 100 envelopes.
 * TTL is measured from the original receipt using the supplied clock.
 * Both times are nonnegative safe integers, so their nonnegative difference is
 * safe; avoid adding TTL to receivedAt, which could exceed MAX_SAFE_INTEGER.
 * A clock before receipt counts as zero elapsed and cannot inflate the wire TTL.
 */
export function listBusInboxAfter(after = 0, limit = 50, options: BusInboxOptions = {}): BusInboxPage {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > BUS_INBOX_MAX_READ) return { status: 'invalid' };
  try {
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) return { status: 'invalid' };
    const snapshot = loadSnapshot(rootPath(options)), messages: BusInboxReceipt[] = [];
    if (after > snapshot.highWater) return { status: 'invalid' };
    let nextCursor = after;
    for (const row of snapshot.rows) {
      if (row.cursor <= after) continue;
      nextCursor = row.cursor;
      const elapsed = Math.max(0, now - row.receivedAt);
      if (elapsed < row.envelope.ttl) {
        messages.push({ ...row, envelope: { ...row.envelope, ttl: row.envelope.ttl - elapsed } });
      }
      if (messages.length === limit) break;
    }
    // Reached the end of retained history: settle on the high-water mark so a
    // pruned or expired tail never makes consumers re-scan dead cursors.
    if (messages.length < limit) nextCursor = Math.max(nextCursor, snapshot.highWater);
    return { status: 'ok', messages, nextCursor };
  } catch { return { status: 'unavailable' }; }
}
