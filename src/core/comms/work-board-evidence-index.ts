import type { BusInboxReceipt } from '../fleet/bus-inbox.js';
import type { BusWorkClaimView } from '../fleet/bus-work-claims.js';

/** Per-read candidate lists in original receipt order. Derivation remains the
 * authority for correlation, chronology, routing, and evidence validity. */
export function indexWorkBoardEvidence(receipts: BusInboxReceipt[], claims: BusWorkClaimView[]): {
  receiptsFor(id: string): BusInboxReceipt[];
  claimsFor(id: string): BusWorkClaimView[];
} {
  const buckets = new Map<string, BusInboxReceipt[]>();
  const first = new Map<string, BusInboxReceipt>();
  const add = (id: string, row: BusInboxReceipt): void => {
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  };
  for (const row of receipts) {
    const id = row.envelope.id;
    const targets = new Set<string>();
    if (!first.has(id)) {
      first.set(id, row);
      targets.add(id);
    }
    const body = row.envelope.body;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      for (const key of ['inReplyTo', 'in_reply_to']) {
        if (Object.hasOwn(record, key) && typeof record[key] === 'string') targets.add(record[key] as string);
      }
    }
    for (const target of targets) add(target, row);
  }
  // Only the first claim at the first receipt's exact coordinates can be
  // observed by deriveBusWorkItemEvidence's find().
  const matchingClaims = new Map<string, BusWorkClaimView[]>();
  for (const claim of claims) {
    const receipt = first.get(claim.id);
    if (receipt && !matchingClaims.has(claim.id) && claim.cursor === receipt.cursor && claim.receivedAt === receipt.receivedAt) {
      matchingClaims.set(claim.id, [claim]);
    }
  }
  return {
    receiptsFor: id => buckets.get(id) ?? [],
    claimsFor: id => matchingClaims.get(id) ?? [],
  };
}
