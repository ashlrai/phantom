/**
 * receipt.v1 signing key custody (slice R2).
 *
 * The Ed25519 key is derived from the host provenance key
 * (~/.ashlr/foundry/provenance.key, see src/core/foundry/provenance.ts), so it
 * inherits that key's custody exactly: 0600 file, owner and directory checks,
 * no env override, and refusal inside a git worktree. No second secret file
 * exists. The seed is HMAC-SHA256(provenance key, domain), so it cannot be
 * used to recover the provenance key, and a provenance key rotation rotates the
 * receipt key with it (the key_id changes, so old receipts read as another key).
 *
 * Signing never uses the provenance module's process-lifetime ephemeral
 * fallback: without a durable key it returns null.
 */
import { createHmac, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import {
  loadExistingProvenanceKey,
  loadExistingProvenanceKeyReadOnly,
  loadOrCreateKey,
} from '../foundry/provenance.js';
import { receiptV1KeyId } from './receipt-v1.js';

const SEED_DOMAIN = 'ashlr.receipt.v1.ed25519-seed';
// PKCS#8 DER prefix for an Ed25519 private key with a 32-byte seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface ReceiptSigningKey { privateKey: KeyObject; publicKey: KeyObject; keyId: string }

/** Pure: Ed25519 key pair from a 32-byte provenance key. Exported for tests. */
export function receiptKeyFromProvenanceKey(provenanceKey: Buffer): ReceiptSigningKey | null {
  if (!Buffer.isBuffer(provenanceKey) || provenanceKey.length !== 32) return null;
  const seed = createHmac('sha256', provenanceKey).update(SEED_DOMAIN, 'utf8').digest();
  try {
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(privateKey);
    const keyId = receiptV1KeyId(publicKey);
    return keyId ? { privateKey, publicKey, keyId } : null;
  } finally {
    seed.fill(0);
  }
}

/** Signing key for this host. Creates the provenance key if absent; null without a durable key. */
export function loadReceiptSigningKey(): ReceiptSigningKey | null {
  try {
    loadOrCreateKey();
    const durable = loadExistingProvenanceKey();
    return durable ? receiptKeyFromProvenanceKey(durable) : null;
  } catch {
    return null;
  }
}

/** Public key for verification and status. Read-only: never creates or repairs storage. */
export function loadReceiptPublicKeyReadOnly(): { publicKey: KeyObject; keyId: string } | null {
  try {
    const durable = loadExistingProvenanceKeyReadOnly();
    const k = durable ? receiptKeyFromProvenanceKey(durable) : null;
    return k ? { publicKey: k.publicKey, keyId: k.keyId } : null;
  } catch {
    return null;
  }
}
