/**
 * Shared pure validation, canonical JSON, digest, stat-identity and Ed25519
 * permit-verification helpers for the daemon runtime-activation and
 * runtime-release protocol modules.
 *
 * Deliberately pure: no filesystem I/O, no child-process execution, no OS or
 * environment reads, and no operational authority.
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';

export type RuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | RuntimeJsonValue[]
  | { [key: string]: RuntimeJsonValue };

export const RUNTIME_SHA256_RE = /^[a-f0-9]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface RuntimeStatIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface RuntimeStatSnapshot extends RuntimeStatIdentity {
  readonly mode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface RuntimeEd25519TrustRoot {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly validFrom: string;
  readonly validUntil: string;
}

export interface VerifyEd25519RuntimePermitOptions {
  label: string;
  permitDomain: string;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  signingBytes: Buffer;
  roots: readonly RuntimeEd25519TrustRoot[];
  nowMs: number;
  maxValidityMs: number;
  maxFutureSkewMs: number;
  keyIdPattern: RegExp;
  maxRoots?: number;
  requireOrderedRootWindow?: boolean;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function equalSha256Digest(left: string, right: string): boolean {
  return (
    RUNTIME_SHA256_RE.test(left) &&
    RUNTIME_SHA256_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}

export function domainBytesSha256(domain: string, value: string | Buffer): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(value)
    .digest('hex');
}

function canonicalizeRuntimeJson(
  value: unknown,
  ancestors: Set<object>,
  omitUndefinedProperties: boolean,
): RuntimeJsonValue | undefined {
  if (omitUndefinedProperties && value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('invalid JSON value');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: RuntimeJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse JSON array');
        const canonical = canonicalizeRuntimeJson(value[index], ancestors, omitUndefinedProperties);
        if (canonical === undefined) throw new TypeError('undefined JSON array entry');
        output.push(canonical);
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('non-plain JSON object');
    }
    const output = Object.create(null) as Record<string, RuntimeJsonValue>;
    for (const key of Object.keys(value as Record<string, unknown>)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
      const canonical = canonicalizeRuntimeJson(
        (value as Record<string, unknown>)[key],
        ancestors,
        omitUndefinedProperties,
      );
      if (canonical !== undefined) output[key] = canonical;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function strictCanonicalJson(
  value: unknown,
  options?: { omitUndefinedProperties?: boolean },
): string {
  const omitUndefinedProperties = options?.omitUndefinedProperties ?? false;
  const canonical = canonicalizeRuntimeJson(value, new Set<object>(), omitUndefinedProperties);
  if (canonical === undefined) throw new TypeError('undefined root JSON value');
  return JSON.stringify(canonical);
}

export function domainCanonicalSha256(
  domain: string,
  value: unknown,
  options?: { omitUndefinedProperties?: boolean },
): string {
  return domainBytesSha256(domain, strictCanonicalJson(value, options));
}

export function parseStrictCanonicalJsonBytes(
  input: string | Buffer,
  maxBytes: number,
  label: string,
  options?: { requireObject?: boolean },
): { value: unknown; canonicalJson: string } {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error(`${label} byte length is invalid`);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (options?.requireObject && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`${label} must be a JSON object`);
  }
  const encoded = `${strictCanonicalJson(value)}\n`;
  if (text !== encoded) throw new Error(`${label} encoding is not canonical`);
  return { value, canonicalJson: encoded };
}

export function decodeCanonicalJsonFrame(
  input: string | Buffer,
  maxBytes: number,
  canonicalize: (value: unknown) => string,
): { text: string; value: unknown } | null {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.at(-1) !== 0x0a) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (Buffer.byteLength(text, 'utf8') !== bytes.length || !text.endsWith('\n')) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    return null;
  }
  try {
    return `${canonicalize(value)}\n` === text ? { text, value } : null;
  } catch {
    return null;
  }
}

export function canonicalValuesEqual(
  left: unknown,
  right: unknown,
  canonicalize: (value: unknown) => string,
): boolean {
  try {
    return equalSha256Digest(sha256Hex(canonicalize(left)), sha256Hex(canonicalize(right)));
  } catch {
    return false;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function strictDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (keys.some((key) => typeof key !== 'string')) return null;
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return null;
  }
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
  }
  return value as Record<string, unknown>;
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function decodeCanonicalBase64url(
  value: unknown,
  expectedBytes?: number,
  maxBytes?: number,
): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === 0) return null;
    if (maxBytes !== undefined && decoded.length > maxBytes) return null;
    if (expectedBytes !== undefined && decoded.length !== expectedBytes) return null;
    return decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
}

export function isBoundedSingleLineText(value: unknown, maxLength = 4_096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/u.test(value)
  );
}

export function isPathContained(root: string, candidate: string, allowEqual = false): boolean {
  const nested = relative(root, candidate);
  return (
    (allowEqual && nested === '') ||
    (nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

export function sameStatIdentity(left: RuntimeStatIdentity, right: RuntimeStatIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameStatSnapshot(left: RuntimeStatSnapshot, right: RuntimeStatSnapshot): boolean {
  return (
    sameStatIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function formatStatSnapshotIdentity(stat: RuntimeStatSnapshot): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].map(String).join(':');
}

export function runtimePermitKeyId(domain: string, publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return sha256Hex(Buffer.concat([Buffer.from(`${domain}:key\0`, 'utf8'), spki]));
}

export function verifyEd25519RuntimePermit(options: VerifyEd25519RuntimePermitOptions): string | null {
  const issued = Date.parse(options.issuedAt);
  const expires = Date.parse(options.expiresAt);
  if (
    !Number.isFinite(options.nowMs) ||
    expires <= issued ||
    expires - issued > options.maxValidityMs ||
    options.nowMs < issued - options.maxFutureSkewMs ||
    options.nowMs >= expires
  ) {
    return `${options.label} permit is outside its validity window`;
  }
  if (!Array.isArray(options.roots) || (options.maxRoots !== undefined && options.roots.length > options.maxRoots)) {
    return `${options.label} signing root is unavailable`;
  }
  const parsedRoots: RuntimeEd25519TrustRoot[] = [];
  const seenKeyIds = new Set<string>();
  for (const candidate of options.roots) {
    const record = strictDataRecord(candidate, [
      'algorithm',
      'keyId',
      'publicKeySpki',
      'validFrom',
      'validUntil',
    ]);
    if (
      !record ||
      record['algorithm'] !== 'ed25519' ||
      typeof record['keyId'] !== 'string' ||
      !options.keyIdPattern.test(record['keyId']) ||
      decodeCanonicalBase64url(record['publicKeySpki']) === null ||
      !isCanonicalTimestamp(record['validFrom']) ||
      !isCanonicalTimestamp(record['validUntil']) ||
      (options.requireOrderedRootWindow && Date.parse(record['validUntil']) <= Date.parse(record['validFrom'])) ||
      seenKeyIds.has(record['keyId'])
    ) {
      return `${options.label} signing root is unavailable`;
    }
    seenKeyIds.add(record['keyId']);
    parsedRoots.push(record as unknown as RuntimeEd25519TrustRoot);
  }
  const root = parsedRoots.find((entry) => entry.keyId === options.keyId) ?? null;
  if (
    !root ||
    Date.parse(root.validFrom) > issued ||
    Date.parse(root.validUntil) < expires ||
    options.nowMs < Date.parse(root.validFrom) ||
    options.nowMs >= Date.parse(root.validUntil)
  ) {
    return `${options.label} signing root is unavailable`;
  }
  const spki = decodeCanonicalBase64url(root.publicKeySpki);
  const signature = decodeCanonicalBase64url(options.signature, 64);
  if (!spki || !signature) {
    return `${options.label} permit signature is invalid`;
  }
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      runtimePermitKeyId(options.permitDomain, key) !== root.keyId ||
      !verify(null, options.signingBytes, key, signature)
    ) {
      return `${options.label} permit signature is invalid`;
    }
  } catch {
    return `${options.label} permit signature is invalid`;
  }
  return null;
}
