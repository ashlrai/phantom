/**
 * receipt.v1 core: shape check, canonical digest, Ed25519 sign and verify
 * (design-receipt-v1.md 3.1 and 3.2, Orchestrator decisions of 2026-10-24).
 *
 * Pure: no I/O, no env, no key storage. Keys are passed in as KeyObjects;
 * key custody (following the provenance-key pattern) lands in a later slice.
 *
 * Secret names never enter a receipt. `injectedNamesSummary` reduces them to
 * a count plus a domain-separated SHA-256 over the sorted, de-duplicated list.
 * Unknown values stay null, never zero. Verification fails closed: unknown
 * `sig.alg`, a key id that does not match the key, extra or missing fields,
 * or anything that does not canonicalize is rejected.
 */
import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { UNWRAPPED_REASONS } from '../run/phantom-custody.js';

export const RECEIPT_V1_SCHEMA = 'receipt.v1' as const;
export const RECEIPT_V1_SIG_ALG = 'ed25519' as const;
const PAYLOAD_DOMAIN = 'ashlr.receipt.v1.payload';
const NAMES_DOMAIN = 'ashlr.receipt.v1.injected-names';
const KEY_ID_DOMAIN = 'ashlr.receipt.v1.key-id';
export const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;
export const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const RECEIPT_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const PREFLIGHT_VERDICTS = ['ready', 'degraded', 'blocked', 'unavailable'] as const;
/** Mirrors ExecutionFeedbackOutcome (src/core/fleet/execution-feedback-types.ts). */
export const EXECUTION_OUTCOMES = [
  'producer-succeeded', 'failed', 'cancelled', 'refused', 'empty-diff', 'disabled', 'unknown',
] as const;

export interface ReceiptV1Secrets {
  initialized: boolean | null;
  status_schema: number | null;
  /** Null when the spawn's custody record is not known to the writer. */
  wrap: { wrapped: boolean; reason: (typeof UNWRAPPED_REASONS)[number] | null } | null;
  preflight: { verdict: (typeof PREFLIGHT_VERDICTS)[number] | null; exit: number | null };
  injected_names_count: number | null;
  injected_names_digest: string | null;
  audit: { enabled: boolean | null; chain_verified: boolean | null; first_seq: number | null; last_seq: number | null };
}

export interface ReceiptV1Body {
  schema: typeof RECEIPT_V1_SCHEMA;
  run_id: string;
  created_at: string;
  repo: string;
  /** Null when the writer does not know the base revision. */
  base_oid: string | null;
  head_oid: string | null;
  identity: { engine: string; seat: string | null; locus_pin_id: string | null; locus_observed: boolean };
  secrets: ReceiptV1Secrets;
  spend: { tokens_in: number | null; tokens_out: number | null; acu: number | null; wall_ms: number };
  change: { diff_sha256: string | null; files_touched: number; lines: number; outside_grant_scope: string[]; grant_digest: string | null };
  approvals: Array<{ tool_name: string; arg_hash: string; approved_at: number }>;
  efficiency: { receipt_digest: string } | null;
  outcome: { execution: (typeof EXECUTION_OUTCOMES)[number] };
  later: unknown[];
}

export interface ReceiptV1Sig { alg: typeof RECEIPT_V1_SIG_ALG; key_id: string; value: string }
export type ReceiptV1 = ReceiptV1Body & { sig: ReceiptV1Sig };

export type ReceiptV1Failure =
  | 'shape-invalid'
  | 'not-canonical'
  | 'alg-unknown'
  | 'key-invalid'
  | 'key-id-mismatch'
  | 'signature-invalid';

/** Count plus digest over secret names. The names themselves are never returned. */
export function injectedNamesSummary(names: readonly string[]): { count: number; digest: string } {
  const sorted = [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash('sha256').update(NAMES_DOMAIN, 'utf8');
  for (const name of sorted) h.update('\n').update(name, 'utf8');
  return { count: sorted.length, digest: h.digest('hex') };
}

// ---------------------------------------------------------------------------
// Closed shape check (shared across receipt.v1 and receipt.v1.later)
// ---------------------------------------------------------------------------
export type ShapeCheck = (v: unknown) => boolean;
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const str = (max = 256): ShapeCheck => (v) => typeof v === 'string' && v.length > 0 && v.length <= max;
export const nullable = (c: ShapeCheck): ShapeCheck => (v) => v === null || c(v);
export const isBool: ShapeCheck = (v) => typeof v === 'boolean';
export const isNonNegativeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const num: ShapeCheck = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export const isHex64: ShapeCheck = (v) => typeof v === 'string' && HEX64_RE.test(v);
export const isOid: ShapeCheck = (v) => typeof v === 'string' && OID_RE.test(v);
export const isOneOf = (list: readonly string[]): ShapeCheck => (v) => typeof v === 'string' && list.includes(v);
export const isRfc3339: ShapeCheck = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v);
const anyInt: ShapeCheck = (v) => Number.isSafeInteger(v);
export function exactRecord(fields: Record<string, ShapeCheck>): ShapeCheck {
  return (v) => isPlainObject(v)
    && Object.keys(v).length === Object.keys(fields).length
    && Object.entries(fields).every(([k, c]) => Object.hasOwn(v, k) && c(v[k]));
}
const arrayOf = (c: ShapeCheck, max: number): ShapeCheck => (v) => Array.isArray(v) && v.length <= max && v.every(c);

const SECRETS = exactRecord({
  initialized: nullable(isBool),
  status_schema: nullable(isNonNegativeInt),
  wrap: nullable(exactRecord({ wrapped: isBool, reason: nullable(isOneOf(UNWRAPPED_REASONS)) })),
  preflight: exactRecord({ verdict: nullable(isOneOf(PREFLIGHT_VERDICTS)), exit: nullable(anyInt) }),
  injected_names_count: nullable(isNonNegativeInt),
  injected_names_digest: nullable(isHex64),
  audit: exactRecord({ enabled: nullable(isBool), chain_verified: nullable(isBool), first_seq: nullable(isNonNegativeInt), last_seq: nullable(isNonNegativeInt) }),
});

const BODY_FIELDS: Record<string, ShapeCheck> = {
  schema: (v) => v === RECEIPT_V1_SCHEMA,
  run_id: (v) => typeof v === 'string' && RUN_ID_RE.test(v),
  created_at: isRfc3339,
  repo: (v) => typeof v === 'string' && RECEIPT_REPO_RE.test(v),
  base_oid: nullable(isOid),
  head_oid: nullable(isOid),
  identity: exactRecord({ engine: str(64), seat: nullable(str(128)), locus_pin_id: nullable(str(128)), locus_observed: isBool }),
  secrets: (v) => {
    if (!SECRETS(v)) return false;
    const s = v as unknown as ReceiptV1Secrets;
    // wrapped:true carries no reason; wrapped:false must name one.
    if (s.wrap !== null && s.wrap.wrapped !== (s.wrap.reason === null)) return false;
    // Count and digest are both known or both unknown.
    return (s.injected_names_count === null) === (s.injected_names_digest === null);
  },
  spend: exactRecord({ tokens_in: nullable(isNonNegativeInt), tokens_out: nullable(isNonNegativeInt), acu: nullable(num), wall_ms: isNonNegativeInt }),
  change: exactRecord({
    diff_sha256: nullable(isHex64), files_touched: isNonNegativeInt, lines: isNonNegativeInt,
    outside_grant_scope: arrayOf(str(512), 4096), grant_digest: nullable(isHex64),
  }),
  approvals: arrayOf(exactRecord({ tool_name: str(128), arg_hash: isHex64, approved_at: isNonNegativeInt }), 1024),
  efficiency: nullable(exactRecord({ receipt_digest: isHex64 })),
  outcome: exactRecord({ execution: isOneOf(EXECUTION_OUTCOMES) }),
  later: (v) => Array.isArray(v) && v.length === 0, // appenders land in a later slice
};
const BODY = exactRecord(BODY_FIELDS);
const SIG_RECORD = exactRecord({ alg: (v) => v === RECEIPT_V1_SIG_ALG, key_id: isHex64, value: (v) => typeof v === 'string' && HEX128_RE.test(v) });

export function isReceiptV1Sig(v: unknown): v is ReceiptV1Sig {
  return SIG_RECORD(v);
}

export function isReceiptV1Body(v: unknown): v is ReceiptV1Body {
  try { return BODY(v); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Digest, key id, sign, verify
// ---------------------------------------------------------------------------
/** Domain-separated SHA-256 over the canonical JSON representation of a payload. */
export function receiptDomainCanonicalDigest(domain: string, payload: unknown): string | null {
  const canonical = canonicalEvidencePackJsonV3(payload);
  if (canonical === null) return null;
  return createHash('sha256').update(domain, 'utf8').update('\n').update(canonical, 'utf8').digest('hex');
}

/** Domain-separated SHA-256 over the canonical body (everything but `sig`). */
export function receiptV1Digest(body: ReceiptV1Body): string | null {
  return isReceiptV1Body(body) ? receiptDomainCanonicalDigest(PAYLOAD_DOMAIN, body) : null;
}

/** Stable key id: domain-separated SHA-256 over the Ed25519 public key (SPKI DER). */
export function receiptV1KeyId(publicKey: KeyObject): string | null {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') return null;
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(KEY_ID_DOMAIN, 'utf8').update('\n').update(der).digest('hex');
}

function signingMessage(domain: string, digest: string): Buffer {
  return Buffer.from(`${domain}\n${RECEIPT_V1_SIG_ALG}\n${digest}`, 'utf8');
}

/** Verify an Ed25519 hex signature over a domain-separated digest. */
export function verifyReceiptSignature(domain: string, digest: string, sigValueHex: string, publicKey: KeyObject): boolean {
  return verify(null, signingMessage(domain, digest), publicKey, Buffer.from(sigValueHex, 'hex'));
}

/** Sign a validated receipt payload under `domain`. Returns null on bad key/digest or key-pair mismatch. */
export function signReceiptPayload<T extends object>(
  domain: string,
  body: T,
  digest: string | null,
  privateKey: KeyObject,
  publicKey: KeyObject,
): (T & { sig: ReceiptV1Sig }) | null {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') return null;
  const keyId = receiptV1KeyId(publicKey);
  if (!keyId || !digest) return null;
  const msg = signingMessage(domain, digest);
  const value = sign(null, msg, privateKey).toString('hex');
  if (!verify(null, msg, publicKey, Buffer.from(value, 'hex'))) return null; // key pair mismatch
  return { ...body, sig: { alg: RECEIPT_V1_SIG_ALG, key_id: keyId, value } };
}

/** Sign a body. Returns null for an invalid body or a key that is not an Ed25519 private key. */
export function signReceiptV1(body: ReceiptV1Body, privateKey: KeyObject, publicKey: KeyObject): ReceiptV1 | null {
  return signReceiptPayload(PAYLOAD_DOMAIN, body, receiptV1Digest(body), privateKey, publicKey);
}

/** Verify a receipt against one trusted public key. Never throws. */
export function verifyReceiptV1(
  receipt: unknown,
  publicKey: KeyObject,
): { ok: true; digest: string } | { ok: false; reason: ReceiptV1Failure } {
  try {
    if (!isPlainObject(receipt) || !Object.hasOwn(receipt, 'sig')) return { ok: false, reason: 'shape-invalid' };
    const { sig, ...body } = receipt;
    if (isPlainObject(sig) && Object.hasOwn(sig, 'alg') && sig['alg'] !== RECEIPT_V1_SIG_ALG) return { ok: false, reason: 'alg-unknown' };
    if (!isReceiptV1Sig(sig) || !isReceiptV1Body(body)) return { ok: false, reason: 'shape-invalid' };
    const keyId = receiptV1KeyId(publicKey);
    if (!keyId) return { ok: false, reason: 'key-invalid' };
    if (sig.key_id !== keyId) return { ok: false, reason: 'key-id-mismatch' };
    const digest = receiptV1Digest(body);
    if (!digest) return { ok: false, reason: 'not-canonical' };
    if (!verifyReceiptSignature(PAYLOAD_DOMAIN, digest, sig.value, publicKey)) return { ok: false, reason: 'signature-invalid' };
    return { ok: true, digest };
  } catch {
    return { ok: false, reason: 'shape-invalid' };
  }
}
