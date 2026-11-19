/** Read the bounded local work feed. Labels grant no execution authority. */
import { BUS_INBOX_MAX_MESSAGES, listBusInboxAfter, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { coordinationRowBlocks, listCoordination, type CoordinationOrigin } from './claim-store.js';
import { projectBusWorkFeed, type WorkFeedResult } from './bus-work-feed.js';
import type { WorkJob } from './bus-v2-schema.js';

/** One live coordination lease blocking a job's declared claim key. */
export interface BusWorkFeedHold {
  jobId: string;
  claimKey: string;
  owner: string;
  leaseUntil: number;
  origin: CoordinationOrigin | 'queue';
  sourceId: string;
}

export interface BusWorkFeedClaims {
  /** missing: verified empty table; unavailable: holds are unknown, not free. */
  source: 'missing' | 'available' | 'unavailable';
  holds: BusWorkFeedHold[];
  /** True when the hold list hit its bound; later holds are not shown. */
  truncated: boolean;
}

export type BusWorkFeedReadResult =
  | { status: 'ok'; jobs: WorkJob[]; receipts: number; asOf: string; claims?: BusWorkFeedClaims }
  | { status: 'refused'; reason: Extract<WorkFeedResult, { status: 'refused' }>['reason']; receipts: number; asOf: string }
  | { status: 'unavailable' | 'retryable' | 'invalid'; asOf: string };

const HOLDS_MAX = 1024;

/** No writes, network, claims or dispatch. Freeze the clock across pages. */
export function readBusWorkFeed(options: { root?: string; now?: () => number; claims?: boolean } = {}): BusWorkFeedReadResult {
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
  if (result.status !== 'ok') return { ...result, receipts: receipts.length, asOf };
  const ok: BusWorkFeedReadResult = { status: 'ok', jobs: result.feed.jobs, receipts: receipts.length, asOf };
  if (!options.claims) return ok;
  const listed = listCoordination(options.root, now);
  const holds: BusWorkFeedHold[] = [];
  let truncated = false;
  if (listed.source === 'available') {
    outer: for (const job of result.feed.jobs) {
      for (const claimKey of job.claimKeys) {
        for (const row of listed.claims) {
          if (!coordinationRowBlocks(row, claimKey)) continue;
          if (holds.length >= HOLDS_MAX) { truncated = true; break outer; }
          holds.push({ jobId: job.id, claimKey, owner: row.owner, leaseUntil: row.leaseUntil,
            origin: row.origin, sourceId: row.sourceId });
        }
      }
    }
  }
  return { ...ok, claims: { source: listed.source, holds, truncated } };
}
