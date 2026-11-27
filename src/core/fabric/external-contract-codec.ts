/**
 * Pure canonical JSON, domain-separated digest, timing-safe comparison, and
 * structural validation helpers shared by the external fabric codecs.
 *
 * Zero I/O: imports only `node:crypto` and performs no filesystem, environment,
 * process, provider, or network access.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SHA256_PREFIXED_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
export const GIT_COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const STACK_SOURCE_VERSION_RE = /^0\.2\.(?:0|[1-9][0-9]*)$/;
const STACK_SOURCE_KEYS = ['commit', 'product', 'version'] as const;

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export interface CanonicalJsonBounds {
  maxDepth: number;
  maxNodes: number;
  maxBytes: number;
}

export interface StackSourceMetadataV1 {
  product: 'stack';
  version: string;
  commit: string;
}

export type DecodedUtf8JsonBytes =
  | { ok: true; copied: Buffer; parsed: unknown }
  | { ok: false; reason: 'invalid-bytes' | 'oversized' | 'non-canonical-json' };

/** Accept only plain objects whose own properties are enumerable string data descriptors. */
export function strictPlainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || descriptors[key]?.enumerable !== true ||
      !Object.hasOwn(descriptors[key]!, 'value'))) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonicalizeJsonValue(
  value: unknown,
  bounds: Pick<CanonicalJsonBounds, 'maxDepth' | 'maxNodes'>,
  state = { depth: 0, nodes: 0, ancestors: new Set<object>() },
): CanonicalJsonValue {
  state.nodes += 1;
  if (state.nodes > bounds.maxNodes || state.depth > bounds.maxDepth) throw new TypeError('value exceeds bounds');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) throw new TypeError('non-json value');
  state.ancestors.add(value);
  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' ||
        (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) throw new TypeError('invalid array');
      const items: CanonicalJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array');
        items.push(canonicalizeJsonValue(value[index], bounds, state));
      }
      return items;
    }
    const row = strictPlainRecord(value);
    if (!row) throw new TypeError('non-plain object');
    const output: { [key: string]: CanonicalJsonValue } = Object.create(null) as { [key: string]: CanonicalJsonValue };
    for (const key of Object.keys(row).sort()) output[key] = canonicalizeJsonValue(row[key], bounds, state);
    return output;
  } finally {
    state.depth -= 1;
    state.ancestors.delete(value);
  }
}

export function canonicalJsonString(
  value: unknown,
  bounds: Partial<Pick<CanonicalJsonBounds, 'maxDepth' | 'maxNodes'>> = {},
): string {
  return JSON.stringify(canonicalizeJsonValue(value, {
    maxDepth: bounds.maxDepth ?? Number.POSITIVE_INFINITY,
    maxNodes: bounds.maxNodes ?? Number.POSITIVE_INFINITY,
  }));
}

export function canonicalJsonBytes(value: unknown, bounds: CanonicalJsonBounds): Buffer | null {
  try {
    const bytes = Buffer.from(canonicalJsonString(value, bounds), 'utf8');
    return bytes.length <= bounds.maxBytes ? bytes : null;
  } catch {
    return null;
  }
}

/** Domain-separated SHA-256 hex digest. Appends a NUL separator unless `domain` ends with one. */
export function sha256Hex(domain: string, value: string | Uint8Array): string {
  const hash = createHash('sha256').update(domain, 'utf8');
  if (!domain.endsWith('\0')) hash.update('\0');
  return hash.update(value).digest('hex');
}

/** Domain-separated `sha256:<hex>` digest. Appends a NUL separator unless `domain` ends with one. */
export function sha256Prefixed(domain: string, value: string | Uint8Array): string {
  return `sha256:${sha256Hex(domain, value)}`;
}

/** Domain-separated HMAC-SHA-256 hex digest. Appends a NUL separator unless `domain` ends with one. */
export function hmacSha256Hex(key: Buffer, domain: string, value: string | Uint8Array): string {
  const mac = createHmac('sha256', key).update(domain, 'utf8');
  if (!domain.endsWith('\0')) mac.update('\0');
  return mac.update(value).digest('hex');
}

export function timingSafeUtf8Equal(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export function isCanonicalIsoTimestamp(value: unknown, maxLength = 40): value is string {
  if (typeof value !== 'string' || value.length > maxLength) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

export function isEnumValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Validate raw caller bytes, clock, UTF-8 round-trip integrity, and JSON syntax. */
export function decodeStrictUtf8JsonBytes(
  bytes: unknown,
  maxBytes: number,
  now: unknown,
): DecodedUtf8JsonBytes {
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: 'invalid-bytes' };
  if (bytes.byteLength > maxBytes) return { ok: false, reason: 'oversized' };
  if (bytes.byteLength < 2 || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { ok: false, reason: 'invalid-bytes' };
  }
  const copied = Buffer.from(bytes);
  const text = copied.toString('utf8');
  if (!copied.equals(Buffer.from(text, 'utf8'))) return { ok: false, reason: 'invalid-bytes' };
  try {
    return { ok: true, copied, parsed: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'non-canonical-json' };
  }
}

export function isValidStackSourceV1(value: unknown): value is StackSourceMetadataV1 {
  const source = strictPlainRecord(value);
  return Boolean(source && exactKeys(source, STACK_SOURCE_KEYS) && source['product'] === 'stack' &&
    typeof source['version'] === 'string' && source['version'].length <= 80 &&
    STACK_SOURCE_VERSION_RE.test(source['version']) &&
    typeof source['commit'] === 'string' && GIT_COMMIT_RE.test(source['commit']));
}

export function isUnsupportedStackSourceVersionV1(value: unknown): boolean {
  const source = strictPlainRecord(value);
  return Boolean(source && exactKeys(source, STACK_SOURCE_KEYS) && source['product'] === 'stack' &&
    typeof source['version'] === 'string' && source['version'].length <= 80 &&
    SEMVER_RE.test(source['version']) && !STACK_SOURCE_VERSION_RE.test(source['version']) &&
    typeof source['commit'] === 'string' && GIT_COMMIT_RE.test(source['commit']));
}
