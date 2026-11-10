/**
 * Decline a chief-of-staff draft. The decline binds the displayed draft digest
 * and takes the same exclusive delivery claim as an approved send, so exactly
 * one of decline and send can win, and an existing sending, sent or uncertain
 * claim is never overwritten (EEXIST). Nothing is sent.
 */
import { writeFile } from 'node:fs/promises';
import { boundCosDraft, closeCosNeedsYou, cosDeliveryPath } from './intake.js';

export async function declineCosDraft(id: string, digest: string, runsDir?: string): Promise<{ id: string; delivery: 'declined' }> {
  if (!await boundCosDraft(id, digest, runsDir)) throw new Error('Explicit decline of the current draft is required');
  await writeFile(cosDeliveryPath(id, runsDir), JSON.stringify({ state: 'declined' }), { flag: 'wx', mode: 0o600 });
  // The durable decline remains authoritative if cleanup fails.
  closeCosNeedsYou(id, runsDir);
  return { id, delivery: 'declined' };
}
