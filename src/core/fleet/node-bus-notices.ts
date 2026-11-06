/**
 * Unread bus notices for one graph node: live P0/P1 envelopes addressed to the
 * node or to every node, newest first. Read-only over the existing durable bus
 * inbox; a missing, unreadable or stale read yields no notices and never throws,
 * so a pack build cannot fail because the bus is unavailable. Message bodies
 * are untrusted data: serialized into notice text, never dispatched.
 */
import {
  BUS_INBOX_MAX_MESSAGES,
  BUS_INBOX_MAX_READ,
  listBusInboxAfter,
  type BusInboxOptions,
  type BusInboxPage,
} from './bus-inbox.js';
import type { NodeContextNotice } from './node-context-pack.js';

/** Address reaching every node; a notice posted to `all` is for everyone. */
export const BUS_ALL_NODES_ADDRESS = 'all';

const NOTICE_PRIORITIES = new Set(['P0', 'P1']);
const MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;

/** ISO 8601 receipt time; a stored ms beyond Date's range renders as digits. */
function isoTime(ms: number): string {
  const time = new Date(ms);
  return Number.isNaN(time.getTime()) ? String(ms) : time.toISOString();
}

export interface NodeBusNoticesDependencies {
  /** Injectable inbox reader; defaults to the durable local bus inbox. */
  read?: typeof listBusInboxAfter;
  options?: BusInboxOptions;
}

/**
 * Collect unread notices for `address`: P0/P1 envelopes addressed to `address`
 * or to `all`, scanned from cursor `after` (the node's own high-water mark; 0
 * means everything retained). Expired records are skipped by the reader itself.
 * Newest first by durable cursor order; bounded by the retained store size.
 * A stale cursor (store reset) retries once from 0; other failures return [].
 */
export function listNodeBusNotices(
  address: string,
  after = 0,
  deps: NodeBusNoticesDependencies = {},
): NodeContextNotice[] {
  const read = deps.read ?? listBusInboxAfter;
  const notices: NodeContextNotice[] = [];
  let cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
  let retried = false;
  for (let scanned = 0; scanned < MAX_PAGES; scanned += 1) {
    let result: BusInboxPage;
    try {
      result = read(cursor, BUS_INBOX_MAX_READ, deps.options);
    } catch {
      break;
    }
    if (result.status !== 'ok' || !Number.isSafeInteger(result.nextCursor) || result.nextCursor < cursor) {
      // A stale cursor can only mean the store was reset; every retained
      // message is unread for this node, so rescan from the beginning once.
      if (!retried && result.status === 'invalid' && cursor !== 0) {
        retried = true;
        cursor = 0;
        scanned = -1;
        continue;
      }
      break;
    }
    for (const row of result.messages) {
      const { envelope } = row;
      if (!NOTICE_PRIORITIES.has(envelope.priority)) continue;
      if (envelope.to !== address && envelope.to !== BUS_ALL_NODES_ADDRESS) continue;
      notices.push({
        id: envelope.id,
        from: envelope.from,
        channel: envelope.to,
        at: isoTime(row.receivedAt),
        priority: envelope.priority,
        text: typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body),
      });
    }
    if (result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  // Durable cursors are ordinal receipt order, so reversing gives newest first.
  return notices.reverse();
}
