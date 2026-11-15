/** Optional CoS plan extension. The host supplies identity; model output supplies only requests. */
import { z } from 'zod';
import { peerRequestSchema, sendPeerMessage, type PeerBusOptions } from '../agentnet/peer-bus.js';
import { agentnetPaths, type PeerSession } from '../agentnet/slack-identities.js';
import { randomUUID } from 'node:crypto';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { localWriteGate } from '../agents/send-gate.js';
export const cosPeerPlanSchema = z.object({ reply: z.string().min(1).max(16_000),
  peers: z.array(peerRequestSchema).max(8) }).strict();
export async function emitCosPeerPlan(plan: z.infer<typeof cosPeerPlanSchema>, session: PeerSession, options?: PeerBusOptions) {
  const checked = cosPeerPlanSchema.parse(plan), results = [];
  for (const request of checked.peers) results.push(await sendPeerMessage(request, session, options));
  if (!localWriteGate()) appendBusInbox({ id: `peer-plan-${randomUUID()}`, from: 'agentnet', to: 'leaders', priority: 'P2', ttl: 86_400_000,
    body: { kind: 'peer.plan', results: results.map(r => ({ status: r.status, id: r.id ?? null, slack: r.slack ?? null })) } },
  { root: options?.busRoot ?? agentnetPaths().busRoot });
  return results;
}
