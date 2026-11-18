/** Shared orchestration.json schema: the leader loop and the CoS peer-plan path write it, the MCP read tool shows it. */
import { join } from 'node:path';
import { z } from 'zod';

/** Lane and specialist labels that mark a receipt written by the chief-of-staff worker, not the leader loop. */
export const COS_PEER_PLAN_LANE = 'cos';
export const COS_PEER_PLAN_SPECIALIST = 'chief-of-staff';

export const receiptSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), job: z.string().max(64), lane: z.string().max(64),
  specialist: z.string().max(64), assignedAt: z.string().datetime(),
  status: z.enum(['reserved', 'admitted', 'complete']),
  delivery: z.string().max(64).optional(), slack: z.string().max(64).optional(),
  /** CoS peer plans only: ids of the peer messages the plan produced (references, never bodies). Absent on older journals. */
  peerMessages: z.array(z.string().regex(/^peer-[a-f0-9-]{36}$/)).max(8).optional(),
}).strict();
export const journalSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema).max(2000) }).strict();
export type OrchestrationReceipt = z.infer<typeof receiptSchema>;
export type OrchestrationJournal = z.infer<typeof journalSchema>;
export const orchestrationJournalPath = (directory: string): string => join(directory, 'orchestration.json');
