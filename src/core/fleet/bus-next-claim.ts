/** One-shot local coordination; message labels do not authenticate or authorize execution. */
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxReceipt } from './bus-inbox.js';
import { BUS_PRIORITIES } from './bus-envelope.js';
import { mutateBusWorkClaim, validBusClaimRequest } from './bus-work-claims.js';

export interface BusNextRequest { to: string; owner: string; leaseMs: number; root?: string }
export type BusNextResult = { status: 'acquired'; receipt: BusInboxReceipt; token: string; leaseUntil: number }
  | { status: string };

export function claimNextBusWork(request: BusNextRequest): BusNextResult {
  const claim = { action: 'acquire' as const, id: request.to, owner: request.owner, leaseMs: request.leaseMs, root: request.root };
  if (!validBusClaimRequest(claim)) return { status: 'invalid' };
  const candidates: BusInboxReceipt[] = [];
  let cursor = 0, scanned = 0, finished = false;
  // An extra page is needed when a full page ends exactly at the high-water mark.
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: request.root });
    if (result.status !== 'ok') return { status: result.status };
    scanned += result.messages.length;
    if (scanned > BUS_INBOX_MAX_MESSAGES || result.nextCursor < cursor) return { status: 'retryable' };
    for (const receipt of result.messages) {
      const body = receipt.envelope.body;
      if (receipt.envelope.to === request.to && body !== null && typeof body === 'object' &&
          !Array.isArray(body) && body.kind === 'work') candidates.push(receipt);
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
