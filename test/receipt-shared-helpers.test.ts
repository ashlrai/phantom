import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exactRecord,
  HEX64_RE,
  isBool,
  isHex64,
  isNonNegativeInt,
  isOid,
  isOneOf,
  isPlainObject,
  isReceiptV1Sig,
  isRfc3339,
  nullable,
  OID_RE,
  RECEIPT_REPO_RE,
  RECEIPT_V1_SIG_ALG,
  receiptDomainCanonicalDigest,
  receiptV1KeyId,
  RUN_ID_RE,
  signReceiptPayload,
  verifyReceiptSignature,
  type ReceiptV1Body,
} from '../src/core/receipt/receipt-v1.js';
import { appendReceiptLater, emitReceiptV1, readReceiptV1 } from '../src/core/receipt/receipt-store.js';
import { buildReceiptTimeline, formatReceiptTimeline } from '../src/core/receipt/receipt-timeline.js';

describe('receipt shared shape and identifier helpers', () => {
  it('validates identifiers and primitive guards', () => {
    expect(RUN_ID_RE.test('run-2026.10_25')).toBe(true);
    expect(RUN_ID_RE.test('')).toBe(false);
    expect(RUN_ID_RE.test('a/b')).toBe(false);
    expect(RUN_ID_RE.test('x'.repeat(129))).toBe(false);

    expect(OID_RE.test('a'.repeat(40))).toBe(true);
    expect(OID_RE.test('0'.repeat(64))).toBe(true);
    expect(OID_RE.test('a'.repeat(39))).toBe(false);
    expect(OID_RE.test('a'.repeat(50))).toBe(false);
    expect(OID_RE.test('A'.repeat(40))).toBe(false);

    expect(RECEIPT_REPO_RE.test('ashlrai/phantom')).toBe(true);
    expect(RECEIPT_REPO_RE.test('ashlrai/phantom/extra')).toBe(false);
    expect(RECEIPT_REPO_RE.test('not a repo')).toBe(false);

    expect(HEX64_RE.test('f'.repeat(64))).toBe(true);
    expect(HEX64_RE.test('f'.repeat(63))).toBe(false);

    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(Object.create(null))).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);

    expect(isBool(true)).toBe(true);
    expect(isBool('true')).toBe(false);

    expect(isNonNegativeInt(0)).toBe(true);
    expect(isNonNegativeInt(42)).toBe(true);
    expect(isNonNegativeInt(-1)).toBe(false);
    expect(isNonNegativeInt(1.5)).toBe(false);
    expect(isNonNegativeInt(Number.MAX_SAFE_INTEGER + 1)).toBe(false);

    expect(isHex64('0'.repeat(64))).toBe(true);
    expect(isHex64('g'.repeat(64))).toBe(false);
    expect(isOid('b'.repeat(40))).toBe(true);
    expect(isOid('not-an-oid')).toBe(false);

    const checkEnum = isOneOf(['alpha', 'beta']);
    expect(checkEnum('alpha')).toBe(true);
    expect(checkEnum('gamma')).toBe(false);
    expect(checkEnum(1)).toBe(false);

    const checkNullable = nullable(isNonNegativeInt);
    expect(checkNullable(null)).toBe(true);
    expect(checkNullable(3)).toBe(true);
    expect(checkNullable(undefined)).toBe(false);
    expect(checkNullable(-1)).toBe(false);

    expect(isRfc3339('2026-10-25T04:00:00Z')).toBe(true);
    expect(isRfc3339('2026-10-25T04:00:00.123456789+05:30')).toBe(true);
    expect(isRfc3339('2026-10-25')).toBe(false);
    expect(isRfc3339('not-a-date')).toBe(false);
  });

  it('enforces closed shapes in exactRecord and isReceiptV1Sig', () => {
    const check = exactRecord({ a: isNonNegativeInt, b: isBool });
    expect(check({ a: 1, b: true })).toBe(true);
    expect(check({ a: 1 })).toBe(false);
    expect(check({ a: 1, b: true, extra: 0 })).toBe(false);
    expect(check(Object.assign(Object.create({ a: 1 }), { b: true }))).toBe(false);

    const validSig = { alg: RECEIPT_V1_SIG_ALG, key_id: 'a'.repeat(64), value: 'b'.repeat(128) };
    expect(isReceiptV1Sig(validSig)).toBe(true);
    expect(isReceiptV1Sig({ ...validSig, alg: 'rsa' })).toBe(false);
    expect(isReceiptV1Sig({ ...validSig, key_id: 'a'.repeat(63) })).toBe(false);
    expect(isReceiptV1Sig({ ...validSig, value: 'b'.repeat(126) })).toBe(false);
    expect(isReceiptV1Sig({ ...validSig, extra: 1 })).toBe(false);
  });
});

describe('receipt shared canonical digest and signing helpers', () => {
  it('computes key-order-independent, domain-separated digests and rejects non-canonical inputs', () => {
    const d1 = receiptDomainCanonicalDigest('test.domain.a', { b: 2, a: 1 });
    const d2 = receiptDomainCanonicalDigest('test.domain.a', { a: 1, b: 2 });
    const d3 = receiptDomainCanonicalDigest('test.domain.b', { a: 1, b: 2 });
    expect(d1).toMatch(HEX64_RE);
    expect(d1).toBe(d2);
    expect(d1).not.toBe(d3);
    expect(receiptDomainCanonicalDigest('test.domain.a', { a: Number.NaN })).toBeNull();
    expect(receiptDomainCanonicalDigest('test.domain.a', { a: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('signs and verifies payloads with domain separation and rejects mismatched or non-Ed25519 keys', () => {
    const k1 = generateKeyPairSync('ed25519');
    const k2 = generateKeyPairSync('ed25519');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const payload = { id: 'p1', count: 3 };
    const digest = receiptDomainCanonicalDigest('test.sign.domain', payload)!;

    const signed = signReceiptPayload('test.sign.domain', payload, digest, k1.privateKey, k1.publicKey);
    expect(signed).not.toBeNull();
    expect(signed!.sig.key_id).toBe(receiptV1KeyId(k1.publicKey));
    expect(verifyReceiptSignature('test.sign.domain', digest, signed!.sig.value, k1.publicKey)).toBe(true);
    expect(verifyReceiptSignature('test.other.domain', digest, signed!.sig.value, k1.publicKey)).toBe(false);
    expect(verifyReceiptSignature('test.sign.domain', digest, signed!.sig.value, k2.publicKey)).toBe(false);
    expect(verifyReceiptSignature('test.sign.domain', '0'.repeat(64), signed!.sig.value, k1.publicKey)).toBe(false);

    expect(signReceiptPayload('test.sign.domain', payload, null, k1.privateKey, k1.publicKey)).toBeNull();
    expect(signReceiptPayload('test.sign.domain', payload, digest, k1.privateKey, k2.publicKey)).toBeNull();
    expect(signReceiptPayload('test.sign.domain', payload, digest, ec.privateKey, ec.publicKey)).toBeNull();
  });
});

describe('receipt store and timeline helper regressions', () => {
  const origHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-receipt-shared-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = origHome;
  });

  function sampleBody(runId: string): ReceiptV1Body {
    return {
      schema: 'receipt.v1',
      run_id: runId,
      created_at: '2026-10-25T06:00:00Z',
      repo: 'ashlrai/phantom',
      base_oid: null,
      head_oid: null,
      identity: { engine: 'codex', seat: null, locus_pin_id: null, locus_observed: false },
      secrets: {
        initialized: null,
        status_schema: null,
        wrap: null,
        preflight: { verdict: null, exit: null },
        injected_names_count: null,
        injected_names_digest: null,
        audit: { enabled: null, chain_verified: null, first_seq: null, last_seq: null },
      },
      spend: { tokens_in: null, tokens_out: null, acu: null, wall_ms: 500 },
      change: { diff_sha256: null, files_touched: 1, lines: 4, outside_grant_scope: [], grant_digest: null },
      approvals: [],
      efficiency: null,
      outcome: { execution: 'producer-succeeded' },
      later: [],
    };
  }

  it('chains multiple later entries via readVerifiedReceipt and formats survival/revert timeline entries', () => {
    expect(emitReceiptV1(sampleBody('run-chain-1')).ok).toBe(true);
    const mergeOid = 'a'.repeat(40);
    const revertOid = 'b'.repeat(40);
    const r0 = appendReceiptLater('run-chain-1', 'merge', { merge_oid: mergeOid, pr_number: 17, method: 'squash' });
    const r1 = appendReceiptLater('run-chain-1', 'survival', { merge_oid: mergeOid, window_hours: 24, reverted: false });
    const r2 = appendReceiptLater('run-chain-1', 'revert', { revert_oid: revertOid, reverted_oid: mergeOid });
    expect(r0).toMatchObject({ ok: true, seq: 0 });
    expect(r1).toMatchObject({ ok: true, seq: 1 });
    expect(r2).toMatchObject({ ok: true, seq: 2 });
    if (r0.ok && r1.ok && r2.ok) {
      expect(r0.digestPrefix).toMatch(/^[0-9a-f]{12}$/);
      expect(r1.digestPrefix).toMatch(/^[0-9a-f]{12}$/);
      expect(r2.digestPrefix).toMatch(/^[0-9a-f]{12}$/);
      expect(new Set([r0.digestPrefix, r1.digestPrefix, r2.digestPrefix]).size).toBe(3);
    }

    const read = readReceiptV1('run-chain-1');
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected verified receipt');
    expect(Object.keys(read).sort()).toEqual(['digest', 'later', 'ok', 'receipt']);
    expect(read.later).toHaveLength(3);

    const timeline = buildReceiptTimeline('run-chain-1', { custody: () => ({ entries: [], malformed: 0 }) });
    expect(timeline.found).toBe(true);
    const rendered = formatReceiptTimeline(timeline);
    expect(rendered).toContain('receipt run-chain-1: verified');
    expect(rendered).toContain(`reverted false · merge ${mergeOid.slice(0, 12)} · window 24h`);
    expect(rendered).toContain(`revert ${revertOid.slice(0, 12)} · reverted ${mergeOid.slice(0, 12)}`);
  });
});
