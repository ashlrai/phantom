/** RQ-BUS-1B: observational bus hops. Never serialize an envelope or its body. */
import { closeSync, constants, fstatSync, lstatSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isProxy } from 'node:util/types';
import { ashlrHome } from '../cloud/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';

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
