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
import type { KeyObject } from 'node:crypto';
import {
  exactRecord,
  isBool,
  isHex64,
  isNonNegativeInt,
  isOid,
  isOneOf,
  isPlainObject,
  isReceiptV1Sig,
  isRfc3339,
  nullable,
  receiptDomainCanonicalDigest,
  receiptV1KeyId,
  RUN_ID_RE,
  signReceiptPayload,
  verifyReceiptSignature,
  type ReceiptV1Sig,
  type ShapeCheck,
} from './receipt-v1.js';

export const RECEIPT_LATER_SCHEMA = 'receipt.v1.later' as const;
const RECEIPT_LATER_KINDS = ['ci', 'merge', 'survival', 'revert'] as const;
const CI_CONCLUSIONS = ['success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required'] as const;
const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export const MAX_LATER_ENTRIES = 64;
const DOMAIN = 'ashlr.receipt.v1.later';

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
const DATA: Record<ReceiptLaterKind, ShapeCheck> = {
  ci: exactRecord({ head_oid: nullable(isOid), conclusion: nullable(isOneOf(CI_CONCLUSIONS)), checks_total: nullable(isNonNegativeInt), checks_failed: nullable(isNonNegativeInt), completed_at: nullable(isRfc3339) }),
  merge: exactRecord({ merge_oid: nullable(isOid), pr_number: nullable(isNonNegativeInt), method: nullable(isOneOf(MERGE_METHODS)), merged_at: nullable(isRfc3339) }),
  survival: exactRecord({ merge_oid: nullable(isOid), window_hours: nullable(isNonNegativeInt), reverted: nullable(isBool), checked_at: nullable(isRfc3339) }),
  revert: exactRecord({ revert_oid: nullable(isOid), reverted_oid: nullable(isOid), reverted_at: nullable(isRfc3339) }),
};

export function isReceiptLaterBody(v: unknown): v is ReceiptLaterBody {
  try {
    if (!isPlainObject(v) || !isOneOf(RECEIPT_LATER_KINDS)(v['kind'])) return false;
    const ok = exactRecord({
      schema: (x) => x === RECEIPT_LATER_SCHEMA,
      run_id: (x) => typeof x === 'string' && RUN_ID_RE.test(x),
      seq: (x) => isNonNegativeInt(x) && x < MAX_LATER_ENTRIES,
      kind: isOneOf(RECEIPT_LATER_KINDS),
      at: isRfc3339,
      parent: isHex64,
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
const pick = (c: ShapeCheck, v: unknown): unknown => (c(v) ? v : null);
export function normalizeLaterData<K extends ReceiptLaterKind>(kind: K, input: Partial<Record<string, unknown>>): LaterDataByKind[K] {
  const i = input ?? {};
  const out: Record<ReceiptLaterKind, () => unknown> = {
    ci: () => {
      const total = pick(isNonNegativeInt, i['checks_total']) as number | null;
      let failed = pick(isNonNegativeInt, i['checks_failed']) as number | null;
      if (total !== null && failed !== null && failed > total) failed = null;
      return { head_oid: pick(isOid, i['head_oid']), conclusion: pick(isOneOf(CI_CONCLUSIONS), i['conclusion']), checks_total: total, checks_failed: failed, completed_at: pick(isRfc3339, i['completed_at']) };
    },
    merge: () => ({ merge_oid: pick(isOid, i['merge_oid']), pr_number: pick(isNonNegativeInt, i['pr_number']), method: pick(isOneOf(MERGE_METHODS), i['method']), merged_at: pick(isRfc3339, i['merged_at']) }),
    survival: () => ({ merge_oid: pick(isOid, i['merge_oid']), window_hours: pick(isNonNegativeInt, i['window_hours']), reverted: pick(isBool, i['reverted']), checked_at: pick(isRfc3339, i['checked_at']) }),
    revert: () => ({ revert_oid: pick(isOid, i['revert_oid']), reverted_oid: pick(isOid, i['reverted_oid']), reverted_at: pick(isRfc3339, i['reverted_at']) }),
  };
  return out[kind]() as LaterDataByKind[K];
}

// --- digest, sign, verify ---------------------------------------------------
function receiptLaterDigest(body: ReceiptLaterBody): string | null {
  return isReceiptLaterBody(body) ? receiptDomainCanonicalDigest(DOMAIN, body) : null;
}

export function signReceiptLater(body: ReceiptLaterBody, privateKey: KeyObject, publicKey: KeyObject): ReceiptLaterEntry | null {
  return signReceiptPayload(DOMAIN, body, receiptLaterDigest(body), privateKey, publicKey);
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
      if (!isPlainObject(e) || !Object.hasOwn(e, 'sig')) return { ok: false, reason: 'later-shape-invalid', index: i };
      const { sig, ...body } = e;
      if (!isReceiptV1Sig(sig) || !isReceiptLaterBody(body)) return { ok: false, reason: 'later-shape-invalid', index: i };
      if (!keyId || sig.key_id !== keyId) return { ok: false, reason: 'later-key-id-mismatch', index: i };
      const digest = receiptLaterDigest(body);
      if (!digest || !verifyReceiptSignature(DOMAIN, digest, sig.value, publicKey)) return { ok: false, reason: 'later-signature-invalid', index: i };
      if (body.run_id !== runId || body.seq !== i || body.parent !== head) return { ok: false, reason: 'later-chain-broken', index: i };
      head = digest;
    } catch {
      return { ok: false, reason: 'later-shape-invalid', index: i };
    }
  }
  return { ok: true, head };
}
