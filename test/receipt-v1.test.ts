import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExecutionFeedbackOutcome } from '../src/core/fleet/execution-feedback-types.js';
import {
  EXECUTION_OUTCOMES,
  injectedNamesSummary,
  isReceiptV1Body,
  receiptV1Digest,
  receiptV1KeyId,
  signReceiptV1,
  verifyReceiptV1,
  type ReceiptV1Body,
} from '../src/core/receipt/receipt-v1.js';

// Keys are generated at runtime; no key material is checked in.
const kp = () => generateKeyPairSync('ed25519');

function body(over: Partial<ReceiptV1Body> = {}): ReceiptV1Body {
  return {
    schema: 'receipt.v1',
    run_id: 'run-2026-10-25-a1',
    created_at: '2026-10-25T04:00:00Z',
    repo: 'ashlrai/phantom',
    base_oid: 'a'.repeat(40),
    head_oid: null,
    identity: { engine: 'aider', seat: null, locus_pin_id: null, locus_observed: false },
    secrets: {
      initialized: true,
      status_schema: 1,
      wrap: { wrapped: false, reason: 'worktree-namespace' },
      preflight: { verdict: null, exit: null },
      injected_names_count: null,
      injected_names_digest: null,
      audit: { enabled: null, chain_verified: null, first_seq: null, last_seq: null },
    },
    spend: { tokens_in: null, tokens_out: null, acu: null, wall_ms: 1200 },
    change: { diff_sha256: null, files_touched: 0, lines: 0, outside_grant_scope: [], grant_digest: null },
    approvals: [],
    efficiency: null,
    outcome: { execution: 'producer-succeeded' },
    later: [],
    ...over,
  };
}

describe('receipt.v1 core', () => {
  it('signs and verifies with a runtime Ed25519 key', () => {
    const { privateKey, publicKey } = kp();
    const r = signReceiptV1(body(), privateKey, publicKey)!;
    expect(r.sig.alg).toBe('ed25519');
    expect(r.sig.key_id).toBe(receiptV1KeyId(publicKey));
    expect(verifyReceiptV1(r, publicKey)).toEqual({ ok: true, digest: receiptV1Digest(body()) });
  });

  it('digest ignores key order', () => {
    const b = body();
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as ReceiptV1Body;
    expect(receiptV1Digest(reordered)).toBe(receiptV1Digest(b));
  });

  it('rejects a tampered field, another key, an unknown alg and a forged key id', () => {
    const { privateKey, publicKey } = kp();
    const r = signReceiptV1(body(), privateKey, publicKey)!;
    expect(verifyReceiptV1({ ...r, spend: { ...r.spend, wall_ms: 1 } }, publicKey)).toEqual({ ok: false, reason: 'signature-invalid' });
    expect(verifyReceiptV1(r, kp().publicKey)).toEqual({ ok: false, reason: 'key-id-mismatch' });
    expect(verifyReceiptV1({ ...r, sig: { ...r.sig, alg: 'hmac-sha256' } }, publicKey)).toEqual({ ok: false, reason: 'alg-unknown' });
    const other = kp();
    const forged = { ...signReceiptV1(body(), other.privateKey, other.publicKey)!, };
    forged.sig = { ...forged.sig, key_id: r.sig.key_id };
    expect(verifyReceiptV1(forged, publicKey)).toEqual({ ok: false, reason: 'signature-invalid' });
    expect(verifyReceiptV1({ ...r, sig: undefined }, publicKey)).toEqual({ ok: false, reason: 'shape-invalid' });
  });

  it('refuses mismatched key pairs and non-Ed25519 keys', () => {
    const a = kp();
    expect(signReceiptV1(body(), a.privateKey, kp().publicKey)).toBeNull();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(signReceiptV1(body(), ec.privateKey, ec.publicKey)).toBeNull();
    expect(receiptV1KeyId(a.privateKey)).toBeNull();
  });

  it('closed shape: extra fields, unknown enums and inconsistent sections are rejected', () => {
    expect(isReceiptV1Body(body())).toBe(true);
    expect(isReceiptV1Body({ ...body(), extra: 1 })).toBe(false);
    const withNames = body();
    (withNames.secrets as unknown as Record<string, unknown>)['injected_names'] = ['X'];
    expect(isReceiptV1Body(withNames)).toBe(false);
    expect(isReceiptV1Body(body({ secrets: { ...body().secrets, wrap: { wrapped: false, reason: null } } }))).toBe(false);
    expect(isReceiptV1Body(body({ secrets: { ...body().secrets, wrap: { wrapped: true, reason: 'unknown' } } }))).toBe(false);
    expect(isReceiptV1Body(body({ secrets: { ...body().secrets, injected_names_count: 2 } }))).toBe(false);
    expect(isReceiptV1Body({ ...body(), outcome: { execution: 'exploded' } })).toBe(false);
    expect(isReceiptV1Body({ ...body(), later: [{}] })).toBe(false);
    expect(isReceiptV1Body({ ...body(), spend: { ...body().spend, tokens_in: 0.5 } })).toBe(false);
  });

  it('outcome enum mirrors ExecutionFeedbackOutcome', () => {
    const all: Record<ExecutionFeedbackOutcome, true> = {
      'producer-succeeded': true, failed: true, cancelled: true, refused: true, 'empty-diff': true, disabled: true, unknown: true,
    };
    expect([...EXECUTION_OUTCOMES].sort()).toEqual(Object.keys(all).sort());
  });

  it('injected names reduce to count plus digest; the names never appear', () => {
    const fake = `FAKE_${randomBytes(8).toString('hex').toUpperCase()}`;
    const s = injectedNamesSummary([fake, 'OTHER_NAME', fake]);
    expect(s.count).toBe(2);
    expect(s.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(injectedNamesSummary(['OTHER_NAME', fake]).digest).toBe(s.digest);
    const { privateKey, publicKey } = kp();
    const r = signReceiptV1(body({ secrets: { ...body().secrets, injected_names_count: s.count, injected_names_digest: s.digest } }), privateKey, publicKey)!;
    expect(JSON.stringify(r)).not.toContain(fake);
    expect(verifyReceiptV1(r, publicKey).ok).toBe(true);
  });
});
