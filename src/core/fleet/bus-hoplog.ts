/** RQ-BUS-1B: observational bus hops. Never serialize an envelope or its body. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isProxy } from 'node:util/types';
import { ashlrHome } from '../cloud/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, utf8Prefix } from '../verse/preferences.js';

/** Structural subset of RQ-BUS-1A's envelope; no dependency on an unmerged transport. */
export interface BusMessageIds { readonly id: string; readonly from: string; readonly to: string }
export interface BusTokenCounts {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
}
export interface BusHop extends BusMessageIds {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** Stop appending when full; concurrent writers can overshoot by their in-flight rows. */
export const BUS_HOPLOG_MAX_BYTES = 8 * 1024 * 1024;
/** Reads never touch more than this tail window, however large the log grows. */
export const BUS_HOPLOG_READ_BYTES = 256 * 1024;
/** Defensive row ceiling for tail reads; API layers enforce their own smaller limits. */
export const BUS_HOPLOG_TAIL_MAX_ROWS = 500;
const ID = /^[\x21-\x7e]{1,128}(?![\s\S])/;

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) throw new Error('Invalid bus metadata.');
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property) return undefined;
  if (!('value' in property)) throw new Error('Invalid bus metadata.');
  return property.value;
}

/** Read only own data fields. Getters, proxies, toJSON and body are never invoked. */
export function busMessageIds(value: unknown): Readonly<BusMessageIds> | null {
  try {
    const id = field(value, 'id'), from = field(value, 'from'), to = field(value, 'to');
    for (const part of [id, from, to]) {
      if (typeof part !== 'string' || !ID.test(part) || scrubSecrets(part) !== part) return null;
    }
    return Object.freeze({ id: id as string, from: from as string, to: to as string });
  } catch { return null; }
}

/** Missing usage is unknown (null), never an invented zero or a body-derived estimate. */
export function createBusHop(ids: unknown, counts: unknown = {}): Readonly<BusHop> | null {
  try {
    const reference = busMessageIds(ids);
    if (!reference) return null;
    const inputTokens = field(counts, 'inputTokens') ?? null;
    const outputTokens = field(counts, 'outputTokens') ?? null;
    for (const count of [inputTokens, outputTokens]) {
      if (count !== null && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) return null;
    }
    return Object.freeze({ ...reference, inputTokens, outputTokens } as BusHop);
  } catch { return null; }
}

export function busHoplogPath(): string {
  return join(ashlrHome(), 'fleet', 'bus', 'hops.jsonl');
}

function privateDirectory(path: string): void {
  ensurePrivateDirectory(path);
  // The shared helper checks ownership/type but deliberately leaves existing modes alone.
  if (process.platform !== 'win32' && (lstatSync(path).mode & 0o077) !== 0) {
    throw new Error('Bus hop directory is not private.');
  }
}

/**
 * One bounded O_APPEND write per hop, 0600 in 0700 directories. Refuse links,
 * nonregular files and foreign/permissive files rather than changing their custody.
 * Failure is observable as false; errors (which may contain bodies) never escape.
 */
export function appendBusHop(value: unknown, file?: string): boolean {
  const hop = createBusHop(value, value);
  if (!hop) return false;
  try {
    const target = file ?? busHoplogPath();
    if (file === undefined) {
      privateDirectory(ashlrHome());
      privateDirectory(join(ashlrHome(), 'fleet'));
    }
    privateDirectory(dirname(target));
    const bytes = Buffer.from(JSON.stringify(hop) + '\n', 'utf8');
    const fd = openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
        stat.size + bytes.length > BUS_HOPLOG_MAX_BYTES) return false;
      // Do not split a row across writes: independent senders share O_APPEND.
      return writeSync(fd, bytes) === bytes.length;
    } finally { closeSync(fd); }
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Read side: bounded observation of the hoplog, same custody contract as the
// writer, no mutations. A hop is only a recorded send attempt; this reports
// metadata, never delivery, bodies, or lifecycle state.
// ---------------------------------------------------------------------------

export type BusHoplogState = 'missing' | 'unreadable' | 'ok';
export interface BusHoplogTail {
  readonly state: BusHoplogState;
  /** On-disk byte size when the log passed custody checks; else null. */
  readonly logBytes: number | null;
  /** Newest validated hops in append order; null unless state is 'ok'. */
  readonly hops: readonly BusHop[] | null;
  /** Malformed, torn or unvalidated rows inside the read window; null unless 'ok'. */
  readonly skippedRows: number | null;
  /** Older bytes or further rows exist beyond what was returned; null unless 'ok'. */
  readonly truncated: boolean | null;
}

function hoplogTail(state: BusHoplogState): BusHoplogTail {
  return { state, logBytes: null, hops: null, skippedRows: null, truncated: null };
}

function errnoCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/** lstat-only privacy check: never creates, never follows a final symlink. */
function privateDirectoryState(path: string): BusHoplogState {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) return 'unreadable';
    return 'ok';
  } catch (error) {
    const code = errnoCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
}

/**
 * Read the newest validated hops from the tail of the log. The file is opened
 * O_RDONLY | O_NOFOLLOW | O_NONBLOCK: links are refused rather than followed and
 * FIFOs fail custody instead of hanging. Rows are revalidated with createBusHop,
 * so malformed, torn, foreign or credential-shaped rows surface only as
 * skippedRows — degraded evidence, never invented activity or extra fields.
 */
export function readBusHoplogTail(limit: number, file?: string): BusHoplogTail {
  const rowLimit = Number.isSafeInteger(limit) && limit >= 1
    ? Math.min(limit, BUS_HOPLOG_TAIL_MAX_ROWS) : 1;
  const target = file ?? busHoplogPath();
  const directories = file === undefined
    ? [ashlrHome(), join(ashlrHome(), 'fleet'), dirname(target)]
    : [dirname(target)];
  for (const directory of directories) {
    const state = privateDirectoryState(directory);
    if (state !== 'ok') return hoplogTail(state);
  }
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = errnoCode(error);
    return hoplogTail(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) return hoplogTail('unreadable');
    const windowBytes = Math.min(stat.size, BUS_HOPLOG_READ_BYTES);
    const offset = stat.size - windowBytes;
    const buffer = Buffer.alloc(windowBytes);
    let read = 0;
    while (read < windowBytes) {
      const chunk = readSync(fd, buffer, read, windowBytes - read, offset + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    const rows = utf8Prefix(buffer.subarray(0, read)).split('\n');
    // A well-formed log ends with '\n', leaving one empty artifact row.
    const terminated = rows[rows.length - 1] === '';
    if (terminated) rows.pop();
    let skipped = 0;
    const hops: BusHop[] = [];
    for (const [index, row] of rows.entries()) {
      // The window can open mid-row; a missing final newline means a torn tail.
      const torn = (offset > 0 && index === 0) ||
        (!terminated && index === rows.length - 1);
      if (torn || row === '') { skipped++; continue; }
      try {
        const parsed: unknown = JSON.parse(row);
        const hop = createBusHop(parsed, parsed);
        if (hop) hops.push(hop); else skipped++;
      } catch { skipped++; }
    }
    const total = hops.length;
    return {
      state: 'ok',
      logBytes: stat.size,
      hops: hops.slice(-rowLimit),
      skippedRows: skipped,
      truncated: stat.size > read || total > rowLimit,
    };
  } catch { return hoplogTail('unreadable'); }
  finally { closeSync(fd); }
}
