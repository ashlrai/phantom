/** Durable routing-only wake hints. Consumers must recheck normal admission.
 * Pathname/FD checks detect custody loss; they do not provide directory-relative
 * creation or atomic confinement against same-owner directory renames. */
import { type BigIntStats, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
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
function tail(fd: number, size: number): BusWakeRow[] {
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
  return rows;
}
export function readBusWakes(opts: { root?: string; sinceAt?: number; limit?: number } = {}): {
  state: 'missing' | 'unreadable' | 'ok'; wakes: BusWakeRow[];
} {
  let fd: number | undefined;
  try {
    const file = busWakeQueuePath(opts.root);
    const pinned = pin(dirname(dirname(file)), dirname(file));
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const rows = tail(fd, checkFile(fd, file, pinned));
    checkFile(fd, file, pinned); // Recheck after reading; later renames remain possible before return.
    const limit = Number.isSafeInteger(opts.limit) && opts.limit! > 0 ? Math.min(opts.limit!, 500) : 500;
    return { state: 'ok', wakes: rows.filter(row => opts.sinceAt === undefined || row.at > opts.sinceAt).slice(-limit) };
  } catch (error) {
    return { state: fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', wakes: [] };
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
      const size = checkFile(fd, file, pinned);
      if (size > maxBytes) throw new Error('Wake queue full');
      if (tail(fd, size).some(row => row.id === ids.id)) {
        checkFile(fd, file, pinned); // Recheck before fsync/acknowledgement; this is not atomic through return.
        fsyncSync(fd);
        fsyncDirectory(directory);
        fsyncDirectory(root);
        return 'duplicate';
      }
      const bytes = Buffer.from(JSON.stringify({ kind: 'bus.send', ...ids, at }) + '\n');
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
