import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import {
  loadReceiptPublicKeyReadOnly,
  loadReceiptSigningKey,
  receiptKeyFromProvenanceKey,
} from '../src/core/receipt/receipt-key.js';
import { signReceiptV1, verifyReceiptV1, type ReceiptV1Body } from '../src/core/receipt/receipt-v1.js';

const origHome = process.env.HOME;
let tmpHome: string;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-receipt-key-home-'));
  process.env.HOME = tmpHome;
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

const body: ReceiptV1Body = {
  schema: 'receipt.v1', run_id: 'run-1', created_at: '2026-10-25T05:00:00Z', repo: 'ashlrai/phantom',
  base_oid: 'b'.repeat(40), head_oid: null,
  identity: { engine: 'aider', seat: null, locus_pin_id: null, locus_observed: false },
  secrets: {
    initialized: null, status_schema: null, wrap: { wrapped: true, reason: null }, preflight: { verdict: null, exit: null },
    injected_names_count: null, injected_names_digest: null,
    audit: { enabled: null, chain_verified: null, first_seq: null, last_seq: null },
  },
  spend: { tokens_in: null, tokens_out: null, acu: null, wall_ms: 0 },
  change: { diff_sha256: null, files_touched: 0, lines: 0, outside_grant_scope: [], grant_digest: null },
  approvals: [], efficiency: null, outcome: { execution: 'unknown' }, later: [],
};

describe('receipt key custody', () => {
  it('derives a stable Ed25519 key from a runtime provenance key', () => {
    const pk = randomBytes(32);
    const a = receiptKeyFromProvenanceKey(pk)!;
    const b = receiptKeyFromProvenanceKey(Buffer.from(pk))!;
    expect(a.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(a.keyId).toBe(b.keyId);
    expect(receiptKeyFromProvenanceKey(randomBytes(32))!.keyId).not.toBe(a.keyId);
  });

  it('rejects a provenance key of the wrong length', () => {
    expect(receiptKeyFromProvenanceKey(randomBytes(31))).toBeNull();
    expect(receiptKeyFromProvenanceKey(Buffer.alloc(0))).toBeNull();
  });

  it('read-only lookup never creates the key', () => {
    expect(loadReceiptPublicKeyReadOnly()).toBeNull();
    expect(fs.existsSync(provenanceKeyPath())).toBe(false);
  });

  it('signing creates the durable provenance key (0600) and verifies via the read-only public key', () => {
    const k = loadReceiptSigningKey()!;
    expect(k).not.toBeNull();
    if (process.platform !== 'win32') expect(fs.statSync(provenanceKeyPath()).mode & 0o777).toBe(0o600);
    const pub = loadReceiptPublicKeyReadOnly()!;
    expect(pub.keyId).toBe(k.keyId);
    const r = signReceiptV1(body, k.privateKey, k.publicKey)!;
    expect(verifyReceiptV1(r, pub.publicKey).ok).toBe(true);
  });

  it('the signing key file holds no Ed25519 material of its own (one secret file only)', () => {
    loadReceiptSigningKey();
    const dir = path.dirname(provenanceKeyPath());
    expect(fs.readdirSync(dir).filter((f) => !f.startsWith('.'))).toEqual(['provenance.key']);
  });
});
