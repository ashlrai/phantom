/** Read-only orchestration receipts; directory selection belongs to the server. */
import { join } from 'node:path';
import { z } from 'zod';
import { readSpecialistFile, specialistRosterDirectory } from '../core/fleet/roster.js';

export const DEFAULT_FLEET_ORCHESTRATION_LIMIT = 25;
export const MAX_FLEET_ORCHESTRATION_LIMIT = 100;

// Identical to orchestrate.ts; kept here to stay within this job's six-file scope.
const receiptSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), job: z.string().max(64), lane: z.string().max(64),
  specialist: z.string().max(64), assignedAt: z.string().datetime(),
  status: z.enum(['reserved', 'admitted', 'complete']),
  delivery: z.string().max(64).optional(), slack: z.string().max(64).optional(),
}).strict();
const journalSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema).max(2000) }).strict();

export interface FleetOrchestrationReadArgs {
  status?: 'reserved' | 'admitted' | 'complete';
  job?: string;
  limit: number;
}
const KEYS = new Set(['status', 'job', 'limit']);

/** Reject invalid arguments before directory resolution or any file read. */
export function parseFleetOrchestrationReadArgs(args: Record<string, unknown>): FleetOrchestrationReadArgs | null {
  if (Object.keys(args).some(key => !KEYS.has(key))) return null;
  const { status, job } = args;
  const limit = args['limit'] === undefined ? DEFAULT_FLEET_ORCHESTRATION_LIMIT : args['limit'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_ORCHESTRATION_LIMIT) return null;
  if (status !== undefined && status !== 'reserved' && status !== 'admitted' && status !== 'complete') return null;
  if (job !== undefined && (typeof job !== 'string' || job.length > 64)) return null;
  return { limit, ...(status === undefined ? {} : { status }), ...(job === undefined ? {} : { job }) };
}

/** One bounded read; parse and filesystem failures propagate to the server's sanitized error handler. */
export async function readFleetOrchestration(input: FleetOrchestrationReadArgs) {
  const raw = await readSpecialistFile(join(specialistRosterDirectory(), 'orchestration.json'));
  const journal = journalSchema.parse(raw === null ? { version: 1, receipts: [] } : JSON.parse(raw));
  const receipts = journal.receipts.sort((a, b) => Date.parse(b.assignedAt) - Date.parse(a.assignedAt));
  // Counts and unresolved reservations describe the entire journal, even when rows are filtered or capped.
  const counts = { reserved: 0, admitted: 0, complete: 0 };
  for (const receipt of receipts) counts[receipt.status]++;
  const matching = receipts.filter(receipt => (input.status === undefined || receipt.status === input.status)
    && (input.job === undefined || receipt.job === input.job));
  return {
    schemaVersion: 1 as const, authority: 'none' as const, source: raw === null ? 'missing' as const : 'ok' as const,
    total: matching.length, truncated: matching.length > input.limit, counts,
    unresolved: receipts.filter(receipt => receipt.status === 'reserved')
      .map(({ job, specialist, assignedAt }) => ({ job, specialist, assignedAt })),
    receipts: matching.slice(0, input.limit),
  };
}
