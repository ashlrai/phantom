/**
 * Joins live claims to the Mason order they serve. Pure and conservative: a
 * claim links only when its job id equals an order's owner job exactly (never
 * a prefix or substring, so a shortened id cannot borrow another worker's
 * identity), and UNKNOWN claims never link.
 */
import type { ParsedClaimExecution } from './claim-execution-model.js';
import type { OrderState, OrderStateParse } from '../fleet-board/order-state-model.js';

export interface ClaimOrderLink { orderKey: string; source: string; at: string; boardState: OrderState }

/** Unparseable timestamps sort oldest. */
const when = (at: string): number => { const ms = Date.parse(at); return Number.isNaN(ms) ? -Infinity : ms; };

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local HH:MM, matching the order strip; 'unknown' when the timestamp does not parse. */
export function linkTime(at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return 'unknown';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function linkClaimsToOrders(
  claims: ParsedClaimExecution,
  orders: OrderStateParse | undefined,
): Map<string, ClaimOrderLink> {
  const links = new Map<string, ClaimOrderLink>();
  if (claims.kind !== 'ok' || orders === undefined || orders.kind !== 'ok') return links;
  const newestByJob = new Map<string, ClaimOrderLink>();
  for (const order of orders.rows) {
    const job = order.owner?.job;
    if (!job) continue;
    const held = newestByJob.get(job);
    if (held === undefined || when(order.at) > when(held.at)) {
      newestByJob.set(job, { orderKey: order.key, source: order.source, at: order.at, boardState: order.state });
    }
  }
  for (const claim of claims.rows) {
    if (claim.jobId === null || claim.state === 'UNKNOWN') continue;
    const link = newestByJob.get(claim.jobId);
    if (link !== undefined) links.set(claim.claimId, link);
  }
  return links;
}
