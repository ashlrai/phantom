/** Durable routing-only wake hints. Consumers must recheck normal admission. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
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
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Unavailable wake directory');
}
function checkFile(fd: number): number {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Unavailable wake file');
  return stat.size;
}
function tail(fd: number): BusWakeRow[] {
  const size = checkFile(fd), length = Math.min(size, BUS_HOPLOG_READ_BYTES);
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
    privateDirectory(dirname(dirname(file)));
    privateDirectory(dirname(file));
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const limit = Number.isSafeInteger(opts.limit) && opts.limit! > 0 ? Math.min(opts.limit!, 500) : 500;
    return { state: 'ok', wakes: tail(fd).filter(row => opts.sinceAt === undefined || row.at > opts.sinceAt).slice(-limit) };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', wakes: [] };
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function enqueueBusWake(request: BusWakeRequest, opts: WakeOptions = {}): 'queued' | 'duplicate' {
  const ids = busMessageIds(request), at = (opts.now ?? Date.now)();
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  if (!ids || request.kind !== 'bus.send' || !Number.isSafeInteger(at) || at < 0 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid wake');
  const file = busWakeQueuePath(opts.root), directory = dirname(file), root = dirname(directory);
  ensurePrivateDirectory(root); privateDirectory(root);
  ensurePrivateDirectory(directory); privateDirectory(directory);
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, 'wake-writer.lock'), 0,
    { anchorPath: root, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new Error('Wake queue refused');
  try {
    const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT |
      constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const size = checkFile(fd);
      if (size > maxBytes) throw new Error('Wake queue full');
      if (tail(fd).some(row => row.id === ids.id)) {
        fsyncSync(fd);
        fsyncDirectory(directory);
        fsyncDirectory(root);
        return 'duplicate';
      }
      const bytes = Buffer.from(JSON.stringify({ kind: 'bus.send', ...ids, at }) + '\n');
      if (size + bytes.length > maxBytes) throw new Error('Wake queue full');
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('Wake queue write failed');
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
