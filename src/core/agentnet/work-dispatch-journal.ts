/** Private dispatch journal: the only proof this host published a peer work.result. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { workResultBodySchema } from '../agents/bus-v2-schema.js';
import { callsignSchema, readPeerJson } from './slack-identities.js';

export const workDispatchReceiptSchema = workResultBodySchema.extend({
  peer: callsignSchema, consumer: callsignSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), at: z.number().int().nonnegative(),
  queueDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sent: workResultBodySchema.shape.outcome.optional(),
}).strict();
export const workDispatchJournalSchema = z.object({ version: z.literal(1),
  receipts: z.array(workDispatchReceiptSchema).max(512) }).strict();
export type WorkDispatchReceipt = z.infer<typeof workDispatchReceiptSchema>;
export type WorkDispatchJournal =
  | { status: 'missing' | 'available'; receipts: WorkDispatchReceipt[] }
  | { status: 'unavailable'; receipts: [] };

export const workDispatchJournalPath = (busRoot: string) => join(busRoot, 'agentnet', 'work-dispatch.json');
export const workDispatchResultBody = (row: WorkDispatchReceipt) => workResultBodySchema.parse({
  kind: row.kind, jobId: row.jobId, claimKey: row.claimKey, queueId: row.queueId,
  receiptId: row.receiptId, outcome: row.outcome, ...(row.reason ? { reason: row.reason } : {}) });

/** Missing means dispatch never ran; invalid private state proves no published result. */
export function readWorkDispatchJournal(busRoot: string): WorkDispatchJournal {
  const file = workDispatchJournalPath(busRoot);
  if (!existsSync(file)) return { status: 'missing', receipts: [] };
  try {
    return { status: 'available',
      receipts: workDispatchJournalSchema.parse(readPeerJson(file, busRoot)).receipts };
  } catch { return { status: 'unavailable', receipts: [] }; }
}
