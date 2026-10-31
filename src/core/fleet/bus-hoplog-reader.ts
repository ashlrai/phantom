/** Bounded, metadata-only observation of the local bus hop log. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { BUS_HOPLOG_MAX_BYTES, busHoplogPath, createBusHop, type BusHop } from './bus-hoplog.js';

const DEFAULT_BYTES = 64 * 1024;
const DEFAULT_ROWS = 100;
const MAX_ROWS = 10_000;

export interface BusHopReadOptions {
  /** Override the log path; omitted paths are resolved at call time. */
  file?: string;
  /** Maximum bytes read, including the boundary byte (2 through 8 MiB). Default 64 KiB. */
  maxBytes?: number;
  /** Maximum valid hops returned (1 through 10,000). Default 100. */
  maxRows?: number;
}

export interface BusHopReadResult {
  /** Missing and unreadable sources never produce hops or filesystem diagnostics. */
  status: 'ok' | 'missing' | 'unreadable';
  /** Valid hops in original file order, selecting the most recent when capped. */
  hops: Readonly<BusHop>[];
  /** Complete rows in the scanned tail that failed UTF-8, JSON or hop validation. */
  invalidRows: number;
  /** The last row lacked a newline and was excluded, even if it was valid JSON. */
  partialFinalRow: boolean;
  /** Earlier bytes were outside the scan; the first cut row is excluded. */
  byteTruncated: boolean;
  /** More valid rows were scanned than could be returned. */
  rowTruncated: boolean;
  /** Actual bytes read, including the boundary byte when applicable. */
  bytesRead: number;
}

function empty(status: BusHopReadResult['status']): BusHopReadResult {
  return { status, hops: [], invalidRows: 0, partialFinalRow: false, byteTruncated: false, rowTruncated: false, bytesRead: 0 };
}

function safe(stat: BigIntStats, directory: boolean): boolean {
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)
    && (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid()))
    && (process.platform === 'win32' || (stat.mode & 0o077n) === 0n);
}

function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/**
 * Read a stable private file snapshot's bounded tail without writing or creating anything.
 * Only newline-terminated rows are considered; a byte-cut leading row and an unfinished
 * final row are excluded. Counts describe the scanned tail, not unobserved history.
 * Concurrent changes or unsafe storage fail closed as unreadable. Invalid limits throw
 * RangeError with a fixed message; no path, file content, or I/O error is returned.
 */
export function readBusHopsDetailed(options: BusHopReadOptions = {}): BusHopReadResult {
  const maxBytes = options.maxBytes ?? DEFAULT_BYTES, maxRows = options.maxRows ?? DEFAULT_ROWS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > BUS_HOPLOG_MAX_BYTES ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
    throw new RangeError('Invalid bus hop read limits.');
  }
  let fd: number | undefined;
  try {
    const file = resolve(options.file ?? busHoplogPath()), parent = dirname(file);
    let pathBefore: BigIntStats;
    try { pathBefore = lstatSync(file, { bigint: true }); }
    catch (error) { return empty((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'); }
    const parentBefore = lstatSync(parent, { bigint: true });
    if (!safe(pathBefore, false) || !safe(parentBefore, true) ||
        !assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: parent }).ok) return empty('unreadable');
    const realParent = realpathSync(parent), realFile = realpathSync(file);
    if (realFile !== resolve(realParent, basename(file))) return empty('unreadable');
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!safe(opened, false) || !same(pathBefore, opened)) return empty('unreadable');
    const byteTruncated = opened.size > BigInt(maxBytes);
    const length = Number(byteTruncated ? BigInt(maxBytes) : opened.size);
    const position = Number(opened.size - BigInt(length));
    if (!Number.isSafeInteger(position)) return empty('unreadable');
    const bytes = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(fd, bytes, bytesRead, length - bytesRead, position + bytesRead);
      if (count === 0) return empty('unreadable');
      bytesRead += count;
    }
    if (!same(opened, fstatSync(fd, { bigint: true })) || !same(opened, lstatSync(file, { bigint: true })) ||
        !same(parentBefore, lstatSync(parent, { bigint: true })) || realParent !== realpathSync(parent) ||
        realFile !== realpathSync(file) || !assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: parent }).ok) {
      return empty('unreadable');
    }
    const partialFinalRow = length > 0 && bytes[length - 1] !== 10;
    let start = 0;
    if (byteTruncated) {
      // The first byte is the boundary probe; only consume following complete rows.
      start = bytes[0] === 10 ? 1 : bytes.indexOf(10) + 1;
      if (start === 0) start = length;
    }
    const end = partialFinalRow ? bytes.lastIndexOf(10) + 1 : length;
    const hops: Readonly<BusHop>[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let invalidRows = 0, rowTruncated = false, next = 0;
    for (let offset = start; offset < end;) {
      const newline = bytes.indexOf(10, offset);
      if (newline < 0 || newline >= end) break;
      const line = bytes.subarray(offset, newline);
      offset = newline + 1;
      let hop: Readonly<BusHop> | null = null;
      try { const parsed: unknown = JSON.parse(decoder.decode(line)); hop = createBusHop(parsed, parsed); } catch { /* invalid row */ }
      if (!hop) { invalidRows++; continue; }
      if (hops.length < maxRows) hops.push(hop);
      else { hops[next] = hop; next = (next + 1) % maxRows; rowTruncated = true; }
    }
    const ordered = rowTruncated ? [...hops.slice(next), ...hops.slice(0, next)] : hops;
    return { status: 'ok', hops: ordered, invalidRows, partialFinalRow, byteTruncated, rowTruncated, bytesRead };
  } catch { return empty('unreadable'); }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}
