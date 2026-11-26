/**
 * Pure structural, canonical-JSON, digest, timestamp, and private-stat helpers
 * shared across the Agent OS epoch and rollover modules (M550–M564).
 *
 * Zero I/O: imports only `node:crypto` and performs no filesystem, environment,
 * network, key, or authority operations.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const AGENT_OS_EPOCH_MAX_V1 = 999_999_999_999;
export const AGENT_OS_EPOCH_MAX_POLICY_GENERATION_V1 = 1_000_000;
export const AGENT_OS_EPOCH_PRIVATE_DIRECTORY_MODE = 0o700;
export const AGENT_OS_EPOCH_PRIVATE_FILE_MODE = 0o600;

export interface CanonicalEpochBounds {
  minBytes: number;
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

export const DEFAULT_CANONICAL_EPOCH_BOUNDS: Readonly<CanonicalEpochBounds> = Object.freeze({
  minBytes: 2,
  maxBytes: 1024 * 1024,
  maxDepth: 32,
  maxNodes: 100_000,
});

export const ROLLOVER_CANONICAL_EPOCH_BOUNDS: Readonly<CanonicalEpochBounds> = Object.freeze({
  minBytes: 1,
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 2_048,
});

export interface EpochStatIdentityLike {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface EpochFileStatLike extends EpochStatIdentityLike {
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

const RAW_DIGEST_RE = /^[a-f0-9]{64}$/;
const PREFIXED_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ARRAY_INDEX_RE = /^(?:0|[1-9][0-9]*)$/;

type CanonicalEpochValue =
  | null
  | boolean
  | number
  | string
  | CanonicalEpochValue[]
  | { [key: string]: CanonicalEpochValue };

/** Accept only plain objects whose own properties are enumerable string data descriptors. */
export function epochPlainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' ||
      descriptors[key]?.enumerable !== true ||
      !Object.hasOwn(descriptors[key]!, 'value'))) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function exactEpochKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/** Validate and snapshot a bounded dense array with no extra properties, symbols, or accessors. */
export function exactDenseEpochArray(value: unknown, maxLength: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || value.length < 0 || value.length > maxLength) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length + 1 ||
      !lengthDescriptor || lengthDescriptor.enumerable !== false) return null;
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        return null;
      }
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

export function deepFreezeEpochValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeEpochValue(nested, seen);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalizeEpochValue(
  value: unknown,
  bounds: Pick<CanonicalEpochBounds, 'maxDepth' | 'maxNodes'>,
  state = { depth: 0, nodes: 0, ancestors: new Set<object>() },
): CanonicalEpochValue {
  state.nodes += 1;
  if (state.nodes > bounds.maxNodes || state.depth > bounds.maxDepth) {
    throw new TypeError('canonical value exceeds bounds');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError('non-canonical number');
    }
    return value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) {
    throw new TypeError('non-json value');
  }
  state.ancestors.add(value);
  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' ||
        (key !== 'length' && !ARRAY_INDEX_RE.test(key)))) {
        throw new TypeError('invalid array');
      }
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array');
        return canonicalizeEpochValue(entry, bounds, state);
      });
    }
    const row = epochPlainRecord(value);
    if (!row) throw new TypeError('non-plain object');
    const output: { [key: string]: CanonicalEpochValue } =
      Object.create(null) as { [key: string]: CanonicalEpochValue };
    for (const key of Object.keys(row).sort()) {
      output[key] = canonicalizeEpochValue(row[key], bounds, state);
    }
    return output;
  } finally {
    state.depth -= 1;
    state.ancestors.delete(value);
  }
}

export function canonicalEpochBytes(
  value: unknown,
  bounds: CanonicalEpochBounds = DEFAULT_CANONICAL_EPOCH_BOUNDS,
): Buffer | null {
  try {
    const bytes = Buffer.from(JSON.stringify(canonicalizeEpochValue(value, bounds)), 'utf8');
    return bytes.length >= bounds.minBytes && bytes.length <= bounds.maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

export function canonicalEpochClone<T>(
  value: T,
  bounds: CanonicalEpochBounds = DEFAULT_CANONICAL_EPOCH_BOUNDS,
): T | null {
  const bytes = canonicalEpochBytes(value, bounds);
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function exactEpochBytes(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sameEpochDigest(left: string, right: string): boolean {
  return exactEpochBytes(Buffer.from(left), Buffer.from(right));
}

export function rawEpochDigest(domain: string, bytes: Uint8Array): string {
  return createHash('sha256').update(domain, 'utf8').update(bytes).digest('hex');
}

export function isValidRawEpochDigest(value: unknown): value is string {
  return typeof value === 'string' && RAW_DIGEST_RE.test(value);
}

export function isValidPrefixedEpochDigest(value: unknown): value is string {
  return typeof value === 'string' && PREFIXED_DIGEST_RE.test(value);
}

export function isValidEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= AGENT_OS_EPOCH_MAX_V1;
}

export function isValidEpochPolicyGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 &&
    Number(value) <= AGENT_OS_EPOCH_MAX_POLICY_GENERATION_V1;
}

export function isValidEpochTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP_RE.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function decodeEpochBase64url(
  value: unknown,
  minimum: number,
  maximum: number,
): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length >= minimum && bytes.length <= maximum && bytes.toString('base64url') === value
      ? bytes
      : null;
  } catch {
    return null;
  }
}

export function epochToken(epoch: number): string {
  return String(epoch).padStart(12, '0');
}

export function matchesEpochAuthority(
  value: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(expected).every(([key, want]) => value[key] === want);
}

function ownedByCurrentUser(stat: Pick<EpochFileStatLike, 'uid'>): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

export function isPrivateEpochDirectory(stat: EpochFileStatLike): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' ||
      (stat.mode & 0o777n) === BigInt(AGENT_OS_EPOCH_PRIVATE_DIRECTORY_MODE));
}

export function isPrivateEpochFile(stat: EpochFileStatLike): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' ||
      (stat.mode & 0o777n) === BigInt(AGENT_OS_EPOCH_PRIVATE_FILE_MODE));
}

export function sameEpochFileIdentity(
  left: EpochStatIdentityLike,
  right: EpochStatIdentityLike,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
