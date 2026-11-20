/** One-shot local coordination; message labels do not authenticate or authorize execution. */
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxReceipt } from './bus-inbox.js';
import { BUS_PRIORITIES, isClaimableWork } from './bus-envelope.js';
import { mutateBusWorkClaim, validBusClaimRequest } from './bus-work-claims.js';
import { agentPendingAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';

export interface BusNextRequest { to: string; owner: string; leaseMs: number; root?: string }
export type BusNextResult = { status: 'acquired'; receipt: BusInboxReceipt; token: string; leaseUntil: number }
  | { status: string };

/**
 * `--to` claims for one agent identity under every routing label that
 * resolves to it — handle, `agent:` address, stable id or alias — or for a
 * `group:<channel>:<topic>` address of a registry channel the identity
 * belongs to, minus the identity's own channel posts: the same membership
 * rule the inbox, wakes and the `work mine` digest's next section apply, so
 * work the digest lists as pending is claimable under the agent's own ref. A
 * `--to` that names no registered identity (a topic such as `fleet.deploy`),
 * membership in no channel and an unreadable registry all keep exact-label
 * matching, so unknown identity state never widens a claim.
 */
function claimAddressMatcher(request: BusNextRequest): (to: string, from: string) => boolean {
  const read = readAgentRegistry({ root: request.root });
  return agentPendingAddressMatcher(request.to, read.status === 'ok' ? read.registry : undefined);
}

export function claimNextBusWork(request: BusNextRequest): BusNextResult {
  const claim = { action: 'acquire' as const, id: request.to, owner: request.owner, leaseMs: request.leaseMs, root: request.root };
  if (!validBusClaimRequest(claim)) return { status: 'invalid' };
  const addressedTo = claimAddressMatcher(request);
  const candidates: BusInboxReceipt[] = [];
  let cursor = 0, scanned = 0, finished = false;
  // An extra page is needed when a full page ends exactly at the high-water mark.
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: request.root });
    if (result.status !== 'ok') return { status: result.status };
    scanned += result.messages.length;
    if (scanned > BUS_INBOX_MAX_MESSAGES || result.nextCursor < cursor) return { status: 'retryable' };
    for (const receipt of result.messages) {
      if (addressedTo(receipt.envelope.to, receipt.envelope.from) && isClaimableWork(receipt.envelope.body)) candidates.push(receipt);
    }
    if (result.messages.length < BUS_INBOX_MAX_READ) { finished = true; break; }
    if (result.nextCursor <= cursor) return { status: 'retryable' };
    cursor = result.nextCursor;
  }
  if (!finished) return { status: 'retryable' };
  candidates.sort((a, b) => BUS_PRIORITIES.indexOf(a.envelope.priority) - BUS_PRIORITIES.indexOf(b.envelope.priority) || a.cursor - b.cursor);
  for (const candidate of candidates) {
    const result = mutateBusWorkClaim({ ...claim, id: candidate.envelope.id });
    if (result.status === 'acquired' && result.token && result.leaseUntil !== undefined) {
      // The ID can have been reclaimed while scanning. Return only the same live
      // receipt that was selected, never an old body paired with a new lease.
      const current = listBusInboxAfter(candidate.cursor - 1, 1, { root: request.root });
      const row = current.status === 'ok' ? current.messages[0] : undefined;
      const { ttl: _ttl, ...selectedEnvelope } = candidate.envelope;
      const { ttl: _currentTtl, ...currentEnvelope } = row?.envelope ?? candidate.envelope;
      if (current.status === 'ok' && Date.now() < result.leaseUntil && row?.cursor === candidate.cursor && row.receivedAt === candidate.receivedAt &&
          JSON.stringify(selectedEnvelope) === JSON.stringify(currentEnvelope)) {
        return { status: 'acquired', receipt: row, token: result.token, leaseUntil: result.leaseUntil };
      }
      const released = mutateBusWorkClaim({ action: 'release', id: candidate.envelope.id, token: result.token, root: request.root });
      if (current.status !== 'ok') return { status: current.status };
      if (!['released', 'lost', 'missing', 'expired', 'mismatched-token'].includes(released.status)) return { status: released.status };
      continue;
    }
    if (['conflict', 'completed', 'expired', 'lost', 'missing'].includes(result.status)) continue;
    return { status: result.status === 'acquired' ? 'unavailable' : result.status };
  }
  return { status: 'empty' };
}
