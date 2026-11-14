/** The Nov12 22:30 ET coordination board, listing form: one bounded read of
 * the durable bus inbox collects the recent request envelopes, then each
 * request is classified through the shared evidence + state rule used by
 * `fleet work-trace`. Read-only: takes no writer lock, writes nothing, makes
 * no network calls and never throws. Bus labels and claim owners grant no
 * authority, and no message body text ever leaves this module. */
import { listBusInboxAfter, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ,
  type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { collectBusWorkItemEvidence } from './work-item-bus-evidence.js';
import { classifyWorkItem, type WorkItemState } from './work-item-state.js';

export const WORK_BOARD_DEFAULT_LIMIT = 20;
export const WORK_BOARD_MAX_LIMIT = 100;

export interface WorkBoardItem {
  id: string;
  /** Envelope channel label ('bus' for legacy envelopes carrying none). */
  channel: string;
  /** Exact channel_ref (e.g. a Slack '<team>/<channel>/<threadTs>'), or null. */
  channelRef: string | null;
  receivedAt: string;
  state: WorkItemState;
  asOf: string;
  source: string;
  missing: string[];
}

export interface WorkBoardResult {
  items: WorkBoardItem[];
  /** 'ok' when the inbox scan settled; 'unavailable' when a page failed. */
  inbox: 'ok' | 'unavailable';
  truncated: boolean;
}

/** A request is any envelope that does not answer another message: replies
 * name their request through `inReplyTo` (bus-reply-post) or `in_reply_to`
 * (peer-protocol bodies). Both absent or null counts as a request; the body
 * is untrusted, so only these two keys are ever read. */
function isRequest(row: BusInboxReceipt): boolean {
  const body = row.envelope.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return true;
  const record = body as Record<string, unknown>;
  return (record['inReplyTo'] === undefined || record['inReplyTo'] === null)
    && (record['in_reply_to'] === undefined || record['in_reply_to'] === null);
}

function limit(opts: { limit?: number }): number {
  return Number.isSafeInteger(opts.limit) && opts.limit! >= 1
    ? Math.min(opts.limit!, WORK_BOARD_MAX_LIMIT) : WORK_BOARD_DEFAULT_LIMIT;
}

export function listWorkBoard(opts: { root: string; now: number; limit?: number; channelRef?: string }): WorkBoardResult {
  const empty: WorkBoardResult = { items: [], inbox: 'unavailable', truncated: false };
  const now = Number.isSafeInteger(opts.now) && opts.now >= 0 ? opts.now : 0;
  try {
    const requests: BusInboxReceipt[] = [];
    let after = 0, settled = false;
    // Same bounded scan as work-item-bus-evidence.ts and bus-work-claims.ts:
    // a zero clock returns original TTL so retained-but-expired receipts list.
    for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
      const result = listBusInboxAfter(after, BUS_INBOX_MAX_READ, { root: opts.root, now: () => 0 });
      if (result.status !== 'ok') break;
      for (const row of result.messages) {
        if (!isRequest(row)) continue;
        if (opts.channelRef !== undefined && row.envelope.channel_ref !== opts.channelRef) continue;
        requests.push(row);
      }
      if (result.nextCursor === after) { settled = true; break; }
      after = result.nextCursor;
    }
    if (!settled) return empty;
    requests.sort((a, b) => b.receivedAt - a.receivedAt || b.cursor - a.cursor);
    const kept = requests.slice(0, limit(opts));
    const asOf = new Date(now).toISOString();
    const items = kept.map(row => {
      const { evidence } = collectBusWorkItemEvidence(row.envelope.id, { root: opts.root, now });
      const classified = classifyWorkItem(evidence, asOf);
      return {
        id: row.envelope.id,
        channel: row.envelope.channel ?? 'bus',
        channelRef: row.envelope.channel_ref ?? null,
        receivedAt: new Date(row.receivedAt).toISOString(),
        state: classified.state,
        asOf: classified.asOf,
        source: classified.source,
        missing: classified.missing,
      };
    });
    return { items, inbox: 'ok', truncated: requests.length > kept.length };
  } catch { return empty; }
}
