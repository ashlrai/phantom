/** Read the bounded local work feed. Labels grant no execution authority. */
import { BUS_INBOX_MAX_MESSAGES, listBusInboxAfter, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { projectBusWorkFeed, type WorkFeedResult } from './bus-work-feed.js';
import type { WorkJob } from './bus-v2-schema.js';

export type BusWorkFeedReadResult =
  | { status: 'ok'; jobs: WorkJob[]; receipts: number; asOf: string }
  | { status: 'refused'; reason: Extract<WorkFeedResult, { status: 'refused' }>['reason']; receipts: number; asOf: string }
  | { status: 'unavailable' | 'retryable' | 'invalid'; asOf: string };

/** No writes, network, claims or dispatch. Freeze the clock across pages. */
export function readBusWorkFeed(options: { root?: string; now?: () => number } = {}): BusWorkFeedReadResult {
  const now = (options.now ?? Date.now)();
  const asOf = new Date(now).toISOString();
  const receipts: BusInboxReceipt[] = [];
  let cursor = 0;
  while (receipts.length < BUS_INBOX_MAX_MESSAGES) {
    const page = listBusInboxAfter(cursor, 100, { root: options.root, now: () => now, includeOriginalEnvelope: true });
    if (page.status !== 'ok') {
      // full/conflict belong to append; conservatively treat them as unavailable.
      const status = page.status === 'invalid' || page.status === 'retryable' ? page.status : 'unavailable';
      return { status, asOf };
    }
    receipts.push(...page.messages.slice(0, BUS_INBOX_MAX_MESSAGES - receipts.length).map(receipt => ({
      cursor: receipt.cursor, receivedAt: receipt.receivedAt,
      envelope: receipt.originalEnvelope ?? receipt.envelope,
    })));
    if (page.messages.length < 100 || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  const result = projectBusWorkFeed(receipts);
  return result.status === 'ok'
    ? { status: 'ok', jobs: result.feed.jobs, receipts: receipts.length, asOf }
    : { ...result, receipts: receipts.length, asOf };
}
