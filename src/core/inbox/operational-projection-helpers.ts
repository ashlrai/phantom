import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

export const SHA256_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const MAX_PROPOSAL_ID_LENGTH = 240;

/** Parse a strict canonical ISO-8601 UTC timestamp (`Date#toISOString()`), or null. */
export function canonicalTimestampMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

export function canonicalTimestamp(value: unknown): value is string {
  return canonicalTimestampMillis(value) !== null;
}

export function validProposalId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PROPOSAL_ID_LENGTH &&
    PROPOSAL_ID_RE.test(value) && value !== '.' && value !== '..';
}

export function equalDigest(left: string, right: string): boolean {
  return SHA256_RE.test(left) && SHA256_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function hmacDomainPayload(key: Buffer, domain: string, payload: string): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(payload, 'utf8')
    .digest('hex');
}

export function deriveDomainSigningKey(provenanceKey: Buffer, keyDomain: string): Buffer {
  return createHmac('sha256', provenanceKey)
    .update(keyDomain, 'utf8')
    .update('\n', 'utf8')
    .digest();
}

export function loadProvenanceKey32(): Buffer | null {
  try {
    const key = loadExistingProvenanceKeyReadOnly();
    return key && key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function loadDerivedDomainKey(
  keyDomain: string,
  keyIdDomain: string,
): { key: Buffer; id: string } | null {
  const provenance = loadProvenanceKey32();
  if (!provenance) return null;
  const key = deriveDomainSigningKey(provenance, keyDomain);
  const id = createHmac('sha256', key)
    .update(keyIdDomain, 'utf8')
    .update('\n', 'utf8')
    .digest('hex');
  return { key, id };
}

export function safePrivatePath(
  path: string,
  kind: 'file' | 'directory',
  exactMode: number,
): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || (kind === 'file'
      ? !stat.isFile() || stat.nlink !== 1n
      : !stat.isDirectory())) return false;
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) return false;
    if (process.platform !== 'win32' && Number(stat.mode & 0o777n) !== exactMode) return false;
    return assurePrivateStoragePath(path, kind, 'inspect-existing', {
      anchorPath: homedir(),
    }).ok;
  } catch {
    return false;
  }
}

export function safePrivateDirectory(path: string): boolean {
  return safePrivatePath(path, 'directory', 0o700);
}
