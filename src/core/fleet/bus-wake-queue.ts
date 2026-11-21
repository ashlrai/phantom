/** Durable routing-only wake hints. Consumers must recheck normal admission.
 * Pathname/FD checks detect custody loss; they do not provide directory-relative
 * creation or atomic confinement against same-owner directory renames. */
import { type BigIntStats, closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { fsyncDirectory } from '../util/durability.js';
import { busMessageIds, BUS_HOPLOG_READ_BYTES } from './bus-hoplog.js';
import type { BusWakeOptions, BusWakeRequest } from './bus-wake.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';

export interface BusWakeRow extends BusWakeRequest { readonly at: number }
interface WakeOptions { root?: string; now?: () => number; maxBytes?: number }
export function busWakeQueuePath(root?: string): string {
  return join(root ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'), 'bus', 'wake-queue.jsonl');
}
type Stat = BigIntStats;
const posix = process.platform !== 'win32';
const ownedByMe = (stat: Stat) => typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
const sameInode = (a: Stat, b: Stat) => a.dev === b.dev && a.ino === b.ino;
/** Runs parent R: owner-owned real directory, never group/world writable. Its mode is never changed. */
function protectedParent(path: string): Stat {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByMe(stat) ||
    (posix && (stat.mode & 0o022n) !== 0n)) throw new Error('Unavailable wake directory');
  return stat;
}
/** R/bus: exactly 0700. Checked before the lock helper, which would otherwise chmod it. */
function privateChild(path: string, anchorPath: string): Stat {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedByMe(stat) ||
    (posix && (stat.mode & 0o7777n) !== 0o700n) ||
    !assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath }).ok) throw new Error('Unavailable wake directory');
  return stat;
}
interface Pin { root: string; bus: string; rootStat: Stat; busStat: Stat }
function pin(root: string, bus: string): Pin {
  return { root, bus, rootStat: protectedParent(root), busStat: privateChild(bus, root) };
}
/** At this check, the pinned directories must still hold the same inodes. */
function stillPinned(p: Pin): void {
  if (!sameInode(protectedParent(p.root), p.rootStat) || !sameInode(privateChild(p.bus, p.root), p.busStat)) {
    throw new Error('Wake directory changed');
  }
}
/** Check the opened private, singly linked inode against its current name and directory identities. */
function checkFile(fd: number, file: string, p: Pin): number {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || !ownedByMe(stat) ||
    (posix && (stat.mode & 0o077n) !== 0n)) throw new Error('Unavailable wake file');
  const named = lstatSync(file, { bigint: true });
  if (named.isSymbolicLink() || !named.isFile() || !sameInode(named, stat)) throw new Error('Wake file changed');
  stillPinned(p);
  return Number(stat.size);
}
function tail(fd: number, size: number): { rows: BusWakeRow[]; cut: boolean } {
  const length = Math.min(size, BUS_HOPLOG_READ_BYTES);
  const buffer = Buffer.alloc(length), offset = size - length;
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, offset + read);
    if (count === 0) break;
    read += count;
  }
  const lines = buffer.subarray(0, read).toString('utf8').split('\n');
  lines.pop(); // Ignore a torn final row, or the terminating newline artifact.
  if (offset > 0) lines.shift();
  const rows: BusWakeRow[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as BusWakeRow;
      const ids = busMessageIds(parsed);
      if (ids && parsed.kind === 'bus.send' && Number.isSafeInteger(parsed.at) && parsed.at >= 0) {
        rows.push({ kind: 'bus.send', ...ids, at: parsed.at });
      }
    } catch { /* Malformed rows are not wake evidence. */ }
  }
  // `cut` marks bytes older than the read window: complete rows may sit
  // beyond it, so any count over `rows` is a lower bound, never a total.
  return { rows, cut: offset > 0 };
}
/**
 * The queue is a bounded hint buffer, not an archive: readers only observe the
 * last BUS_HOPLOG_READ_BYTES, so on overflow keep exactly that observable tail
 * — complete rows only, torn edges dropped — rewritten in place. A second
 * descriptor without O_APPEND performs the rewrite; both descriptors must name
 * the same inode or the call refuses rather than compacting a swapped file.
 * Returns the retained byte count, the file's new size.
 */
function compactWakeTail(fd: number, file: string, pinned: Pin, retainBytes: number): number {
  const other = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    checkFile(other, file, pinned);
    const otherStat = fstatSync(other, { bigint: true });
    if (!sameInode(fstatSync(fd, { bigint: true }), otherStat)) throw new Error('Wake file changed');
    const size = Number(otherStat.size);
    const window = Math.min(size, Math.max(0, retainBytes));
    const buffer = Buffer.alloc(window);
    const offset = size - window;
    let read = 0;
    while (read < window) {
      const count = readSync(other, buffer, read, window - read, offset + read);
      if (count === 0) break;
      read += count;
    }
    const view = buffer.subarray(0, read);
    const first = view.indexOf(0x0a), last = view.lastIndexOf(0x0a);
    const start = first === -1 ? view.length : first + 1;
    const end = last === -1 ? 0 : last + 1;
    const kept = start < end ? view.subarray(start, end) : Buffer.alloc(0);
    let written = 0;
    while (written < kept.length) {
      const count = writeSync(other, kept, written, kept.length - written, written);
      if (count <= 0) throw new Error('Wake queue write failed');
      written += count;
    }
    ftruncateSync(other, kept.length);
    checkFile(other, file, pinned);
    return kept.length;
  } finally { closeSync(other); }
}
export function readBusWakes(opts: { root?: string; sinceAt?: number; limit?: number;
  /** Keep only rows the predicate accepts; `matched` still counts every accepted row. */
  match?: (row: BusWakeRow) => boolean } = {}): {
  state: 'missing' | 'unreadable' | 'ok'; wakes: BusWakeRow[];
  /** Rows passing `sinceAt`/`match` observed in the bounded tail, before `limit`; null unless the queue was read ('ok' or verified-'missing'). */
  matched: number | null;
  /** Older bytes or matched rows sit beyond what `wakes` returned; null when the queue state is unknown. */
  truncated: boolean | null;
} {
  let fd: number | undefined;
  try {
    const file = busWakeQueuePath(opts.root);
    const pinned = pin(dirname(dirname(file)), dirname(file));
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const { rows, cut } = tail(fd, checkFile(fd, file, pinned));
    checkFile(fd, file, pinned); // Recheck after reading; later renames remain possible before return.
    const limit = Number.isSafeInteger(opts.limit) && opts.limit! > 0 ? Math.min(opts.limit!, 500) : 500;
    const matched = rows.filter(row => (opts.sinceAt === undefined || row.at > opts.sinceAt) &&
      (opts.match === undefined || opts.match(row)));
    const kept = matched.slice(-limit);
    return { state: 'ok', wakes: kept, matched: matched.length, truncated: cut || kept.length < matched.length };
  } catch (error) {
    const missing = fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT';
    return missing
      ? { state: 'missing', wakes: [], matched: 0, truncated: false }
      : { state: 'unreadable', wakes: [], matched: null, truncated: null };
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function enqueueBusWake(request: BusWakeRequest, opts: WakeOptions = {}): 'queued' | 'duplicate' {
  const ids = busMessageIds(request), at = (opts.now ?? Date.now)();
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  if (!ids || request.kind !== 'bus.send' || !Number.isSafeInteger(at) || at < 0 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid wake');
  const file = busWakeQueuePath(opts.root), directory = dirname(file), root = dirname(directory);
  ensurePrivateDirectory(root); protectedParent(root);
  ensurePrivateDirectory(directory); privateChild(directory, root);
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, 'wake-writer.lock'), 0,
    { anchorPath: root, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new Error('Wake queue refused');
  try {
    const pinned = pin(root, directory);
    const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT |
      constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      let size = checkFile(fd, file, pinned);
      const bytes = Buffer.from(JSON.stringify({ kind: 'bus.send', ...ids, at }) + '\n');
      // A row that can never fit an empty queue is refused before dedupe or
      // compaction touches the file, as the old capacity check did.
      if (bytes.length > maxBytes) throw new Error('Wake queue full');
      if (tail(fd, size).rows.some(row => row.id === ids.id)) {
        checkFile(fd, file, pinned); // Recheck before fsync/acknowledgement; this is not atomic through return.
        fsyncSync(fd);
        fsyncDirectory(directory);
        fsyncDirectory(root);
        return 'duplicate';
      }
      if (size + bytes.length > maxBytes) {
        // Wakes are ephemeral hints and readers observe only the last
        // BUS_HOPLOG_READ_BYTES, so compact to that observable tail rather
        // than reporting the queue full forever once it reaches maxBytes.
        size = compactWakeTail(fd, file, pinned, Math.min(BUS_HOPLOG_READ_BYTES, maxBytes - bytes.length));
      }
      if (size + bytes.length > maxBytes) throw new Error('Wake queue full');
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('Wake queue write failed');
      checkFile(fd, file, pinned); // Detect custody loss after appending, before fsync/acknowledgement.
      fsyncSync(fd);
      fsyncDirectory(directory);
      fsyncDirectory(root);
      return 'queued';
    } finally { closeSync(fd); }
  } finally { releaseLocalStoreLock(acquired.lock); }
}
export function busWakeQueueEnqueue(root?: string): BusWakeOptions['enqueue'] {
  return async (request, signal) => {
    if (signal.aborted) throw new Error('Wake aborted');
    enqueueBusWake(request, { root });
  };
}
