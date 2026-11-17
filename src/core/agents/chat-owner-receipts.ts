/** Private bounded provenance ledger. Permanent accepted IDs are never recycled. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { ashlrHome } from '../cloud/store.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assertPrivateBusPath, busPathMissing } from '../fleet/bus-inbox.js';
import type { BusEnvelope } from '../fleet/bus-envelope.js';
export class OwnerChatCapacityError extends Error {}
const MAX_BYTES = 512 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ownerReceiptSchema = z.object({ id: z.string().regex(/^owner-chat-[a-f0-9]{32}$/),
  recipients: z.array(z.string().regex(/^agt_[a-f0-9]{20}$/)).min(1).max(256).refine(ids => new Set(ids).size === ids.length),
  contentDigest: hash, envelopeDigest: hash, state: z.enum(['pending', 'accepted', 'rejected']),
  cursor: z.number().int().safe().nonnegative(), receivedAt: z.number().int().safe().nonnegative(),
}).strict();
export type OwnerChatReceipt = z.infer<typeof ownerReceiptSchema>;
export const ownerChatRoot = (root?: string) => root ?? join(ashlrHome(), 'fleet');
export const ownerReceiptDir = (root: string) => join(root, 'owner-chat-receipts');
const schema = z.array(ownerReceiptSchema).max(1024).refine(rows => new Set(rows.map(r => r.id)).size === rows.length);
export const ownerEnvelopeDigest = (envelope: BusEnvelope) => createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
export function readOwnerChatReceipts(root: string): OwnerChatReceipt[] {
  const dir = ownerReceiptDir(root), file = join(dir, 'receipts.json');
  if (busPathMissing(dir)) return [];
  assertPrivateBusPath(dir, 'directory', root);
  if (busPathMissing(file)) return [];
  assertPrivateBusPath(file, 'file', root);
  const read = readStableRegularFile(file, { anchorPath: root, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!read.ok) throw new Error('Owner chat receipts unavailable');
  return schema.parse(JSON.parse(read.text));
}
export function writeOwnerChatReceipts(root: string, rows: OwnerChatReceipt[]): void {
  const dir = ownerReceiptDir(root);
  const checked = schema.parse(rows);
  // Reserve the largest accepted cursor before committing any pending record.
  if (Buffer.byteLength(JSON.stringify(checked.map(row => ({ ...row, state: 'accepted', cursor: Number.MAX_SAFE_INTEGER })))) > MAX_BYTES) throw new OwnerChatCapacityError('Owner chat receipt capacity');
  const encoded = JSON.stringify(checked);
  writePrivateFileAtomically(join(dir, `.pending-${randomUUID()}`), join(dir, 'receipts.json'), encoded,
    { anchorPath: root, label: 'Owner chat receipt' });
}
export function ownerChatReceiptState(envelope: BusEnvelope, cursor: number, receipts: readonly OwnerChatReceipt[], viewer?: string): OwnerChatReceipt['state'] | undefined {
  return receipts.find(row => (viewer === undefined || row.recipients.includes(viewer)) && row.id === envelope.id && (row.state === 'pending' || row.cursor === cursor) &&
    row.envelopeDigest === ownerEnvelopeDigest(envelope))?.state;
}

export function verifiedOwnerChat(envelope: BusEnvelope, cursor: number, receipts: readonly OwnerChatReceipt[], viewer?: string): boolean {
  return ownerChatReceiptState(envelope, cursor, receipts, viewer) === 'accepted';
}
