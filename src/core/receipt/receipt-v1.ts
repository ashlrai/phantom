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
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export const PREFLIGHT_VERDICTS = ['ready', 'degraded', 'blocked', 'unavailable'] as const;
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
// Closed shape check
// ---------------------------------------------------------------------------
type Check = (v: unknown) => boolean;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const str = (max = 256): Check => (v) => typeof v === 'string' && v.length > 0 && v.length <= max;
const nul = (c: Check): Check => (v) => v === null || c(v);
const bool: Check = (v) => typeof v === 'boolean';
const int: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const hex64: Check = (v) => typeof v === 'string' && HEX64.test(v);
const oid: Check = (v) => typeof v === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v);
const oneOf = (list: readonly string[]): Check => (v) => typeof v === 'string' && list.includes(v);
const rfc3339: Check = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v);
const anyInt: Check = (v) => Number.isSafeInteger(v);
function record(fields: Record<string, Check>): Check {
  return (v) => isObj(v)
    && Object.keys(v).length === Object.keys(fields).length
    && Object.entries(fields).every(([k, c]) => Object.hasOwn(v, k) && c(v[k]));
}
const arrayOf = (c: Check, max: number): Check => (v) => Array.isArray(v) && v.length <= max && v.every(c);

const SECRETS = record({
  initialized: nul(bool),
  status_schema: nul(int),
  wrap: nul(record({ wrapped: bool, reason: nul(oneOf(UNWRAPPED_REASONS)) })),
  preflight: record({ verdict: nul(oneOf(PREFLIGHT_VERDICTS)), exit: nul(anyInt) }),
  injected_names_count: nul(int),
  injected_names_digest: nul(hex64),
  audit: record({ enabled: nul(bool), chain_verified: nul(bool), first_seq: nul(int), last_seq: nul(int) }),
});

const BODY_FIELDS: Record<string, Check> = {
  schema: (v) => v === RECEIPT_V1_SCHEMA,
  run_id: (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(v),
  created_at: rfc3339,
  repo: (v) => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v),
  base_oid: nul(oid),
  head_oid: nul(oid),
  identity: record({ engine: str(64), seat: nul(str(128)), locus_pin_id: nul(str(128)), locus_observed: bool }),
  secrets: (v) => {
    if (!SECRETS(v)) return false;
    const s = v as unknown as ReceiptV1Secrets;
    // wrapped:true carries no reason; wrapped:false must name one.
    if (s.wrap !== null && s.wrap.wrapped !== (s.wrap.reason === null)) return false;
    // Count and digest are both known or both unknown.
    return (s.injected_names_count === null) === (s.injected_names_digest === null);
  },
  spend: record({ tokens_in: nul(int), tokens_out: nul(int), acu: nul(num), wall_ms: int }),
  change: record({
    diff_sha256: nul(hex64), files_touched: int, lines: int,
    outside_grant_scope: arrayOf(str(512), 4096), grant_digest: nul(hex64),
  }),
  approvals: arrayOf(record({ tool_name: str(128), arg_hash: hex64, approved_at: int }), 1024),
  efficiency: nul(record({ receipt_digest: hex64 })),
  outcome: record({ execution: oneOf(EXECUTION_OUTCOMES) }),
  later: (v) => Array.isArray(v) && v.length === 0, // appenders land in a later slice
};
const BODY = record(BODY_FIELDS);
const SIG = record({ alg: (v) => v === RECEIPT_V1_SIG_ALG, key_id: hex64, value: (v) => typeof v === 'string' && HEX128.test(v) });

export function isReceiptV1Body(v: unknown): v is ReceiptV1Body {
  try { return BODY(v); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Digest, key id, sign, verify
// ---------------------------------------------------------------------------
/** Domain-separated SHA-256 over the canonical body (everything but `sig`). */
export function receiptV1Digest(body: ReceiptV1Body): string | null {
  if (!isReceiptV1Body(body)) return null;
  const canonical = canonicalEvidencePackJsonV3(body);
  if (canonical === null) return null;
  return createHash('sha256').update(PAYLOAD_DOMAIN, 'utf8').update('\n').update(canonical, 'utf8').digest('hex');
}

/** Stable key id: domain-separated SHA-256 over the Ed25519 public key (SPKI DER). */
export function receiptV1KeyId(publicKey: KeyObject): string | null {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') return null;
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(KEY_ID_DOMAIN, 'utf8').update('\n').update(der).digest('hex');
}

function message(digest: string): Buffer {
  return Buffer.from(`${PAYLOAD_DOMAIN}\n${RECEIPT_V1_SIG_ALG}\n${digest}`, 'utf8');
}

/** Sign a body. Returns null for an invalid body or a key that is not an Ed25519 private key. */
export function signReceiptV1(body: ReceiptV1Body, privateKey: KeyObject, publicKey: KeyObject): ReceiptV1 | null {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') return null;
  const keyId = receiptV1KeyId(publicKey);
  const digest = receiptV1Digest(body);
  if (!keyId || !digest) return null;
  const value = sign(null, message(digest), privateKey).toString('hex');
  if (!verify(null, message(digest), publicKey, Buffer.from(value, 'hex'))) return null; // key pair mismatch
  return { ...body, sig: { alg: RECEIPT_V1_SIG_ALG, key_id: keyId, value } };
}

/** Verify a receipt against one trusted public key. Never throws. */
export function verifyReceiptV1(
  receipt: unknown,
  publicKey: KeyObject,
): { ok: true; digest: string } | { ok: false; reason: ReceiptV1Failure } {
  try {
    if (!isObj(receipt) || !Object.hasOwn(receipt, 'sig')) return { ok: false, reason: 'shape-invalid' };
    const { sig, ...body } = receipt;
    if (isObj(sig) && Object.hasOwn(sig, 'alg') && sig['alg'] !== RECEIPT_V1_SIG_ALG) return { ok: false, reason: 'alg-unknown' };
    if (!SIG(sig) || !isReceiptV1Body(body)) return { ok: false, reason: 'shape-invalid' };
    const keyId = receiptV1KeyId(publicKey);
    if (!keyId) return { ok: false, reason: 'key-invalid' };
    const s = sig as unknown as ReceiptV1Sig;
    if (s.key_id !== keyId) return { ok: false, reason: 'key-id-mismatch' };
    const digest = receiptV1Digest(body);
    if (!digest) return { ok: false, reason: 'not-canonical' };
    if (!verify(null, message(digest), publicKey, Buffer.from(s.value, 'hex'))) return { ok: false, reason: 'signature-invalid' };
    return { ok: true, digest };
  } catch {
    return { ok: false, reason: 'shape-invalid' };
  }
}
