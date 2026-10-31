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
function load(root: string): BusInboxReceipt[] {
  const directory = join(root, 'bus-inbox'), file = join(directory, 'messages.json');
  if (missing(root)) return [];
  privatePath(root, 'directory', root);
  if (missing(directory)) return [];
  privatePath(directory, 'directory', root);
  if (missing(file)) return [];
  privatePath(file, 'file', root);
  const read = readStableRegularFile(file, { anchorPath: root, maxFileBytes: BUS_INBOX_MAX_BYTES, remainingBytes: BUS_INBOX_MAX_BYTES });
  if (!read.ok) throw new Error('Unavailable');
  const rows: unknown = JSON.parse(read.text);
  if (!Array.isArray(rows) || rows.length > BUS_INBOX_MAX_MESSAGES) throw new Error('Unavailable');
  const ids = new Set<string>();
  return rows.map((row: BusInboxReceipt, index) => {
    if (!row || Object.keys(row).sort().join() !== 'cursor,envelope,receivedAt' || row.cursor !== index + 1 ||
      !Number.isSafeInteger(row.receivedAt) || row.receivedAt < 0) throw new Error('Unavailable');
    const checked = validateBusEnvelope(row.envelope);
    if (!checked.ok || ids.has(checked.value.id)) throw new Error('Unavailable');
    ids.add(checked.value.id);
    return { cursor: row.cursor, receivedAt: row.receivedAt, envelope: checked.value };
  });
}
/** Atomic bounded snapshot: retained IDs and ordinal cursors never reset or evict. */
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
      const rows = load(root), previous = rows.find(row => row.envelope.id === checked.value.id);
      if (previous) return JSON.stringify(previous.envelope) === checked.json
        ? { status: 'duplicate', id: checked.value.id, cursor: previous.cursor } : { status: 'conflict' };
      const receivedAt = (options.now ?? Date.now)();
      if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) return { status: 'invalid' };
      const cursor = rows.length + 1;
      rows.push({ cursor, receivedAt, envelope: checked.value });
      const json = JSON.stringify(rows);
      if (rows.length > BUS_INBOX_MAX_MESSAGES || Buffer.byteLength(json) > BUS_INBOX_MAX_BYTES) return { status: 'full' };
      writePrivateFileAtomically(join(directory, '.pending'), join(directory, 'messages.json'), json, { anchorPath: root, label: 'Bus inbox' });
      return { status: 'posted', id: checked.value.id, cursor };
    } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { return { status: 'unavailable' }; }
}
/** nextCursor advances over expired records, including an entirely expired page.
 * Scan is capped at 1 MiB / 1024 retained records; output at 100 envelopes.
 * TTL is always measured from the original receipt, never renewed on replay.
 */
export function listBusInboxAfter(after = 0, limit = 50, options: BusInboxOptions = {}): BusInboxPage {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > BUS_INBOX_MAX_READ) return { status: 'invalid' };
  try {
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) return { status: 'invalid' };
    const rows = load(rootPath(options)), messages: BusInboxReceipt[] = [];
    if (after > rows.length) return { status: 'invalid' };
    let nextCursor = after;
    for (const row of rows) {
      if (row.cursor <= after) continue;
      nextCursor = row.cursor;
      if (now - row.receivedAt < row.envelope.ttl) messages.push(row);
      if (messages.length === limit) break;
    }
    return { status: 'ok', messages, nextCursor };
  } catch { return { status: 'unavailable' }; }
}
