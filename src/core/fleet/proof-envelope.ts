/** Bounded local review evidence. Provenance is supplied by the trusted publisher,
 * never inferred from notes. Hashes establish integrity, not execution authority. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { scrubPrivateText } from '../util/scrub.js';

export const PROOF_MAX_BYTES = 64 * 1024;
export const PROOF_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;
const text = z.string().min(1).max(2048);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const proofEnvelopeSchema = z.object({
  schema: z.literal('fleet.proof.v1'),
  claims: z.array(text).max(32),
  evidence: z.array(z.object({
    kind: z.enum(['diff', 'test-output', 'state-diff', 'log', 'screenshot-ref']),
    ref: text,
    sha256: sha.optional(),
    capturedBy: z.enum(['tool', 'agent']),
  }).strict()).max(64),
  verification: z.array(z.object({ cmd: text, exitCode: z.number().int().min(0).max(255), summary: text }).strict()).max(32),
  diffStats: z.object({ files: count, added: count, removed: count }).strict(),
  riskTier: z.enum(['low', 'medium', 'high', 'unknown']),
  reviewerChecklist: z.array(text).min(1).max(32),
}).strict();
export type ProofEnvelope = z.infer<typeof proofEnvelopeSchema>;
export const proofHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const redactProofText = (value: string): string => scrubPrivateText(value)
  // Short secret assignments also need redaction in exported artifacts.
  .replace(/\b(password|passwd|pwd|api[_-]?key|(?:access[_-]?|refresh[_-]?|auth[_-]?)?token|client[_-]?secret|secret)\s*[=:]\s*["']?[^\s,"';]+/gi, '$1=[REDACTED]');

/** Scrub all free text before serialization; preserve only validated digest fields. */
export function serializeProofEnvelope(input: unknown): string {
  const value = proofEnvelopeSchema.parse(input);
  const clean = (items: string[]) => items.map(redactProofText);
  const output = JSON.stringify({ ...value, claims: clean(value.claims),
    evidence: value.evidence.map(e => ({ ...e, ref: redactProofText(e.ref) })),
    verification: value.verification.map(v => ({ ...v, cmd: redactProofText(v.cmd), summary: redactProofText(v.summary) })),
    reviewerChecklist: clean(value.reviewerChecklist),
  }, null, 2) + '\n';
  if (Buffer.byteLength(output) > PROOF_MAX_BYTES) throw new Error('Proof envelope exceeds byte bound');
  proofEnvelopeSchema.parse(JSON.parse(output));
  return output;
}

/** A single bounded read; reject links, FIFOs and devices before reading. */
export function readProofBytes(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new Error('Unavailable or oversized proof artifact');
    const data = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < data.length) {
      const bytes = readSync(fd, data, used, data.length - used, null);
      if (bytes === 0) break;
      used += bytes;
    }
    if (used > limit) throw new Error('Proof artifact exceeds byte bound');
    return data.subarray(0, used);
  } finally { closeSync(fd); }
}

export const readProofFile = (path: string, limit: number): string => readProofBytes(path, limit).toString('utf8');

/** Local sibling names only: never follow URLs, absolute paths or path traversal. */
export function localProofRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(ref) && !ref.includes('..');
}
export interface ProofReview { schema: 'fleet.proof-review.v1'; ok: boolean; checklist: string[]; flags: string[] }

/** resultRef is a proof JSON or a publisher's .publish file with a digest-bound marker.
 * No recorded command is executed. No network references are fetched. */
export function verifyProofResult(resultRef: string): ProofReview {
  const flags: string[] = [];
  let checklist: string[] = [];
  try {
    let file = resultRef;
    let expected: string | undefined;
    if (resultRef.endsWith('.publish')) {
      const markers = readProofFile(resultRef, PROOF_MAX_BYTES).split('\n').filter(line => line.startsWith('PROOF '));
      const marker = markers.length === 1 ? /^PROOF (\S+) sha256:([a-f0-9]{64})$/.exec(markers[0]!) : null;
      if (!marker || !localProofRef(marker[1]!)) throw new Error('Missing or invalid proof marker');
      file = join(dirname(resultRef), marker[1]!); expected = marker[2]!;
    }
    const raw = readProofFile(file, PROOF_MAX_BYTES);
    if (expected && proofHash(raw) !== expected) throw new Error('Proof envelope digest mismatch');
    const envelope = proofEnvelopeSchema.parse(JSON.parse(raw));
    checklist = envelope.reviewerChecklist.map(redactProofText);
    if (serializeProofEnvelope(envelope) !== JSON.stringify(envelope, null, 2) + '\n') flags.push('Envelope contains unredacted private text');
    const artifacts = new Map<string, string>();
    for (const [index, evidence] of envelope.evidence.entries()) {
      if (evidence.capturedBy === 'agent') { flags.push(`Evidence ${index}: agent assertion; does not count as proof`); continue; }
      if (!evidence.sha256 || !localProofRef(evidence.ref)) { flags.push(`Evidence ${index}: missing digest or nonlocal reference`); continue; }
      try {
        const bytes = readProofBytes(join(dirname(file), evidence.ref), PROOF_ARTIFACT_MAX_BYTES);
        const artifact = bytes.toString('utf8');
        if (proofHash(bytes) !== evidence.sha256) { flags.push(`Evidence ${index}: digest mismatch`); continue; }
        artifacts.set(evidence.ref, artifact);
      } catch { flags.push(`Evidence ${index}: missing or unreadable artifact`); }
    }
    // The capture controller records the diff stat and exact patch digest in a state receipt.
    const diff = envelope.evidence.find(e => e.kind === 'diff' && e.capturedBy === 'tool' && artifacts.has(e.ref));
    const states = envelope.evidence.filter(e => e.kind === 'state-diff' && e.capturedBy === 'tool' && artifacts.has(e.ref));
    const receipts: Record<string, unknown>[] = [];
    for (const state of states) {
      try { const receipt: unknown = JSON.parse(artifacts.get(state.ref)!); if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) receipts.push(receipt as Record<string, unknown>); } catch { /* invalid receipts cannot prove anything */ }
    }
    if (!diff) flags.push('Missing tool-captured diff');
    if (!diff || !receipts.some(r => r['patchSha256'] === diff.sha256 && proofEnvelopeSchema.shape.diffStats.safeParse(r['diffStats']).success &&
      Object.entries(envelope.diffStats).every(([key, value]) => (r['diffStats'] as Record<string, unknown>)[key] === value))) flags.push('Missing or mismatched diff statistics receipt');
    if (envelope.verification.length === 0) flags.push('Missing command verification');
    for (const [index, verification] of envelope.verification.entries()) {
      if (verification.exitCode !== 0) flags.push(`Verification ${index}: command failed (exit ${verification.exitCode})`);
      if (!receipts.some(r => r['cmd'] === verification.cmd && r['exitCode'] === verification.exitCode &&
        envelope.evidence.some(e => e.kind === 'test-output' && e.capturedBy === 'tool' && artifacts.has(e.ref) && e.sha256 === r['outputSha256']))) flags.push(`Verification ${index}: missing or mismatched tool receipt/output`);
    }
    if (envelope.riskTier === 'unknown') flags.push('Risk tier requires reviewer classification');
    if (!expected) flags.push('Standalone envelope: publisher digest binding unavailable');
  } catch { flags.push('Missing, invalid, oversized or mismatched proof envelope'); }
  return { schema: 'fleet.proof-review.v1', ok: flags.length === 0, checklist, flags };
}
