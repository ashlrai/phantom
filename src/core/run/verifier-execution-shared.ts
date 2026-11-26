/**
 * Pure validation, encoding, and Ed25519 SPKI helpers shared by the
 * verifier-execution observation modules. No I/O, clock, env, or signing.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const VERIFIER_EXECUTION_DIGEST_RE = /^[0-9a-f]{64}$/;
export const VERIFIER_EXECUTION_MAX_LIFETIME_MS = 10 * 60 * 1_000;

export const VERIFIER_EXECUTION_PLATFORMS = ['darwin', 'linux', 'win32'] as const;
export const VERIFIER_EXECUTION_ARCHITECTURES = ['arm64', 'x64'] as const;
export const VERIFIER_EXECUTION_BACKENDS = [
  'linux-namespace-cgroup-broker',
  'macos-virtualization-framework-broker',
  'windows-appcontainer-job-broker',
] as const;

export type VerifierExecutionPlatform = typeof VERIFIER_EXECUTION_PLATFORMS[number];
export type VerifierExecutionArchitecture = typeof VERIFIER_EXECUTION_ARCHITECTURES[number];
export type VerifierExecutionBackend = typeof VERIFIER_EXECUTION_BACKENDS[number];

interface CanonicalEd25519PublicKey {
  key: KeyObject;
  bytes: Buffer;
}

export function sha256Domain(
  domain: string,
  ...parts: readonly (string | Uint8Array)[]
): string {
  const hash = createHash('sha256').update(`${domain}\0`, 'utf8');
  for (const part of parts) {
    if (typeof part === 'string') hash.update(part, 'utf8');
    else hash.update(part);
  }
  return hash.digest('hex');
}

export function exactPlainRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => !Object.hasOwn(descriptor, 'value'),
  )) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function plainDataGraph(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (depth > 8 || seen.size >= 512 || seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 128) return false;
  } else if (prototype !== Object.prototype && prototype !== null) return false;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || !plainDataGraph(descriptor.value, seen, depth + 1)) {
      return false;
    }
  }
  return true;
}

export function denseArray(value: unknown, minimum: number, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum || value.length > maximum ||
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

export function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function canonicalBase64Url(
  value: unknown,
  minimumBytes: number,
  maximumBytes = minimumBytes,
): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
    !BASE64URL.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length >= minimumBytes && bytes.length <= maximumBytes &&
      bytes.toString('base64url') === value ? bytes : null;
  } catch { return null; }
}

export function sortedEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T[] {
  if (!denseArray(value, 1, allowed.length)) return false;
  let prior = '';
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.includes(entry as T) || entry <= prior) return false;
    prior = entry;
  }
  return true;
}

function parseCanonicalEd25519Spki(
  publicKeySpki: unknown,
): CanonicalEd25519PublicKey | null {
  const bytes = canonicalBase64Url(publicKeySpki, 32, 128);
  if (!bytes) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || !canonical.equals(bytes)) {
      return null;
    }
    return { key, bytes };
  } catch { return null; }
}

/** Compute a domain-separated key identifier from a canonical Ed25519 SPKI key. */
export function ed25519KeyId(domain: string, publicKeySpki: unknown): string | null {
  const parsed = parseCanonicalEd25519Spki(publicKeySpki);
  return parsed ? sha256Domain(domain, parsed.bytes) : null;
}

/** Parse a canonical Ed25519 SPKI key and confirm it matches `expectedKeyId` under `domain`. */
export function verifiedEd25519PublicKey(
  domain: string,
  publicKeySpki: unknown,
  expectedKeyId: string,
): KeyObject | null {
  const parsed = parseCanonicalEd25519Spki(publicKeySpki);
  return parsed && sha256Domain(domain, parsed.bytes) === expectedKeyId ? parsed.key : null;
}

/** Decode a canonical 64-byte base64url Ed25519 signature and verify it against `payload`. */
export function verifyEd25519Signature(
  payload: Buffer,
  publicKey: KeyObject,
  signature: unknown,
): Buffer | null {
  const signatureBytes = canonicalBase64Url(signature, 64);
  if (!signatureBytes) return null;
  try {
    return verifySignature(null, payload, publicKey, signatureBytes) ? signatureBytes : null;
  } catch { return null; }
}
