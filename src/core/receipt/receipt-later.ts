/**
 * receipt.v1 later[] entries (slice R6): what happened after a run closed
 * (ci, merge, survival, revert), appended without touching the signed body.
 *
 * Design (design-receipt-v1.md 3.2): each entry is a separate document signed
 * with the receipt key over its own canonical digest. The signed payload
 * includes run_id, seq and `parent`, the digest of the previous link (the
 * receipt body digest for seq 0, else the previous entry's digest). The chain
 * makes amendments append-only: editing, reordering, splicing in another run's
 * entry or removing a middle entry fails verification. The original signed
 * body (whose `later` stays []) is never rewritten.
 *
 * Pure: no I/O. Value-free data only: statuses, oids, counts, timestamps.
 * Unknown values are null. Closed shapes: extra or missing keys are rejected.
 */
import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { receiptV1KeyId, RECEIPT_V1_SIG_ALG, type ReceiptV1Sig } from './receipt-v1.js';

export const RECEIPT_LATER_SCHEMA = 'receipt.v1.later' as const;
export const RECEIPT_LATER_KINDS = ['ci', 'merge', 'survival', 'revert'] as const;
export const CI_CONCLUSIONS = ['success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required'] as const;
export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export const MAX_LATER_ENTRIES = 64;
const DOMAIN = 'ashlr.receipt.v1.later';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export type ReceiptLaterKind = (typeof RECEIPT_LATER_KINDS)[number];
export interface CiData { head_oid: string | null; conclusion: (typeof CI_CONCLUSIONS)[number] | null; checks_total: number | null; checks_failed: number | null; completed_at: string | null }
export interface MergeData { merge_oid: string | null; pr_number: number | null; method: (typeof MERGE_METHODS)[number] | null; merged_at: string | null }
export interface SurvivalData { merge_oid: string | null; window_hours: number | null; reverted: boolean | null; checked_at: string | null }
export interface RevertData { revert_oid: string | null; reverted_oid: string | null; reverted_at: string | null }
export interface LaterDataByKind { ci: CiData; merge: MergeData; survival: SurvivalData; revert: RevertData }

export interface ReceiptLaterBody<K extends ReceiptLaterKind = ReceiptLaterKind> {
  schema: typeof RECEIPT_LATER_SCHEMA;
  run_id: string;
  seq: number;
  kind: K;
  at: string;
  parent: string;
  data: LaterDataByKind[K];
}
export type ReceiptLaterEntry = ReceiptLaterBody & { sig: ReceiptV1Sig };

export type ReceiptLaterFailure =
  | 'later-shape-invalid'
  | 'later-key-id-mismatch'
  | 'later-signature-invalid'
  | 'later-chain-broken'
  | 'later-too-many';

// --- closed shape ----------------------------------------------------------
type Check = (v: unknown) => boolean;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const nul = (c: Check): Check => (v) => v === null || c(v);
const int: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const bool: Check = (v) => typeof v === 'boolean';
const oid: Check = (v) => typeof v === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v);
const oneOf = (list: readonly string[]): Check => (v) => typeof v === 'string' && list.includes(v);
const rfc3339: Check = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v);
function record(fields: Record<string, Check>): Check {
  return (v) => isObj(v)
    && Object.keys(v).length === Object.keys(fields).length
    && Object.entries(fields).every(([k, c]) => Object.hasOwn(v, k) && c(v[k]));
}
const DATA: Record<ReceiptLaterKind, Check> = {
  ci: record({ head_oid: nul(oid), conclusion: nul(oneOf(CI_CONCLUSIONS)), checks_total: nul(int), checks_failed: nul(int), completed_at: nul(rfc3339) }),
  merge: record({ merge_oid: nul(oid), pr_number: nul(int), method: nul(oneOf(MERGE_METHODS)), merged_at: nul(rfc3339) }),
  survival: record({ merge_oid: nul(oid), window_hours: nul(int), reverted: nul(bool), checked_at: nul(rfc3339) }),
  revert: record({ revert_oid: nul(oid), reverted_oid: nul(oid), reverted_at: nul(rfc3339) }),
};
const SIG = record({ alg: (v) => v === RECEIPT_V1_SIG_ALG, key_id: (v) => typeof v === 'string' && HEX64.test(v), value: (v) => typeof v === 'string' && HEX128.test(v) });

export function isReceiptLaterBody(v: unknown): v is ReceiptLaterBody {
  try {
    if (!isObj(v) || !oneOf(RECEIPT_LATER_KINDS)(v['kind'])) return false;
    const ok = record({
      schema: (x) => x === RECEIPT_LATER_SCHEMA,
      run_id: (x) => typeof x === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(x),
      seq: (x) => int(x) && (x as number) < MAX_LATER_ENTRIES,
      kind: oneOf(RECEIPT_LATER_KINDS),
      at: rfc3339,
      parent: (x) => typeof x === 'string' && HEX64.test(x),
      data: DATA[v['kind'] as ReceiptLaterKind],
    })(v);
    if (!ok) return false;
    const d = v['data'] as Record<string, unknown>;
    return !(v['kind'] === 'ci' && d['checks_total'] !== null && d['checks_failed'] !== null && (d['checks_failed'] as number) > (d['checks_total'] as number));
  } catch {
    return false;
  }
}

// --- normalizers: unknown or invalid input values become null --------------
const pick = (c: Check, v: unknown): unknown => (c(v) ? v : null);
export function normalizeLaterData<K extends ReceiptLaterKind>(kind: K, input: Partial<Record<string, unknown>>): LaterDataByKind[K] {
  const i = input ?? {};
  const out: Record<ReceiptLaterKind, () => unknown> = {
    ci: () => {
      const total = pick(int, i['checks_total']) as number | null;
      let failed = pick(int, i['checks_failed']) as number | null;
      if (total !== null && failed !== null && failed > total) failed = null;
      return { head_oid: pick(oid, i['head_oid']), conclusion: pick(oneOf(CI_CONCLUSIONS), i['conclusion']), checks_total: total, checks_failed: failed, completed_at: pick(rfc3339, i['completed_at']) };
    },
    merge: () => ({ merge_oid: pick(oid, i['merge_oid']), pr_number: pick(int, i['pr_number']), method: pick(oneOf(MERGE_METHODS), i['method']), merged_at: pick(rfc3339, i['merged_at']) }),
    survival: () => ({ merge_oid: pick(oid, i['merge_oid']), window_hours: pick(int, i['window_hours']), reverted: pick(bool, i['reverted']), checked_at: pick(rfc3339, i['checked_at']) }),
    revert: () => ({ revert_oid: pick(oid, i['revert_oid']), reverted_oid: pick(oid, i['reverted_oid']), reverted_at: pick(rfc3339, i['reverted_at']) }),
  };
  return out[kind]() as LaterDataByKind[K];
}

// --- digest, sign, verify ---------------------------------------------------
export function receiptLaterDigest(body: ReceiptLaterBody): string | null {
  if (!isReceiptLaterBody(body)) return null;
  const canonical = canonicalEvidencePackJsonV3(body);
  if (canonical === null) return null;
  return createHash('sha256').update(DOMAIN, 'utf8').update('\n').update(canonical, 'utf8').digest('hex');
}
const message = (digest: string): Buffer => Buffer.from(`${DOMAIN}\n${RECEIPT_V1_SIG_ALG}\n${digest}`, 'utf8');

export function signReceiptLater(body: ReceiptLaterBody, privateKey: KeyObject, publicKey: KeyObject): ReceiptLaterEntry | null {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') return null;
  const keyId = receiptV1KeyId(publicKey);
  const digest = receiptLaterDigest(body);
  if (!keyId || !digest) return null;
  const value = sign(null, message(digest), privateKey).toString('hex');
  if (!verify(null, message(digest), publicKey, Buffer.from(value, 'hex'))) return null;
  return { ...body, sig: { alg: RECEIPT_V1_SIG_ALG, key_id: keyId, value } };
}

/**
 * Verify a full chain against the receipt it amends. Entries must be in seq
 * order 0..n-1, belong to runId, and each parent must be the previous link.
 * Returns the digest of the last link (the parent for the next append).
 */
export function verifyReceiptLaterChain(
  runId: string,
  receiptDigest: string,
  entries: readonly unknown[],
  publicKey: KeyObject,
): { ok: true; head: string } | { ok: false; reason: ReceiptLaterFailure; index: number } {
  if (entries.length > MAX_LATER_ENTRIES) return { ok: false, reason: 'later-too-many', index: MAX_LATER_ENTRIES };
  const keyId = receiptV1KeyId(publicKey);
  let head = receiptDigest;
  for (let i = 0; i < entries.length; i++) {
    try {
      const e = entries[i];
      if (!isObj(e) || !Object.hasOwn(e, 'sig')) return { ok: false, reason: 'later-shape-invalid', index: i };
      const { sig, ...body } = e;
      if (!SIG(sig) || !isReceiptLaterBody(body)) return { ok: false, reason: 'later-shape-invalid', index: i };
      const s = sig as unknown as ReceiptV1Sig;
      if (!keyId || s.key_id !== keyId) return { ok: false, reason: 'later-key-id-mismatch', index: i };
      const digest = receiptLaterDigest(body);
      if (!digest || !verify(null, message(digest), publicKey, Buffer.from(s.value, 'hex'))) return { ok: false, reason: 'later-signature-invalid', index: i };
      if (body.run_id !== runId || body.seq !== i || body.parent !== head) return { ok: false, reason: 'later-chain-broken', index: i };
      head = digest;
    } catch {
      return { ok: false, reason: 'later-shape-invalid', index: i };
    }
  }
  return { ok: true, head };
}
