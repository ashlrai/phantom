import { formatRelative } from '../autonomy/format.js';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';

export function unreadForMason(receipts: readonly AgentBusReceipt[], seenCursor: number, now = Date.now()) {
  const unread = receipts.filter(row => row.cursor > seenCursor && row.envelope.to.toLowerCase() === 'mason');
  const newest = unread.reduce<AgentBusReceipt | null>((latest, row) => !latest || row.cursor > latest.cursor ? row : latest, null);
  return {
    count: unread.length,
    newestCursor: newest?.cursor ?? null,
    newestFrom: newest?.envelope.from ?? null,
    newestAgeText: newest ? formatRelative(new Date(newest.receivedAt).toISOString(), now) : null,
  };
}

export function chipText(count: number, newestFrom: string | null): string {
  return count === 1 && newestFrom ? `1 new for you on the bus (from ${newestFrom})` : `${count} new for you on the bus`;
}
