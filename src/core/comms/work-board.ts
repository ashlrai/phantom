/** The Nov12 22:30 ET coordination board, listing form: one bounded read of
 * the durable bus inbox collects the recent request envelopes, then each
 * request is classified through the shared evidence + state rule used by
 * `fleet work-trace`. Read-only: takes no writer lock, writes nothing, makes
 * no network calls and never throws. Bus labels and claim owners grant no
 * authority, and no message body text ever leaves this module.
 *
 * Every listed item is derived from the same settled inbox scan plus one
 * claims inspection, so a board response is one internally consistent
 * evidence projection even while the fleet churns; nothing is cached across
 * calls. */
import { inspectBusWorkClaims, type BusWorkClaimView } from '../fleet/bus-work-claims.js';
import type { BusInboxReceipt } from '../fleet/bus-inbox.js';
import { deriveBusWorkItemEvidence, readBusInboxEvidence } from './work-item-bus-evidence.js';
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
  /** Named claim owner bound to this exact receipt, or null when no claim
   * row matches its id+cursor+receivedAt coordinates. */
  owner: string | null;
  /** `bus-claim:<id>:<cursor>:<receivedAt>` receipt of the matched claim, or
   * null. Never a fencing token. */
  claimReceipt: string | null;
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
    // One settled bounded inbox read for the whole board; an unsettled or
    // churning scan reports 'unavailable', never a partial listing.
    const read = readBusInboxEvidence(opts.root);
    if (read.status !== 'ok') return empty;
    // One claims inspection for the whole board. A missing or unreadable
    // table yields no claim rows — items still list, owners stay null.
    let claims: BusWorkClaimView[] = [];
    try { claims = inspectBusWorkClaims(opts.root).claims; } catch { /* unavailable: no claim rows */ }
    const requests: BusInboxReceipt[] = [];
    for (const row of read.receipts) {
      if (!isRequest(row)) continue;
      if (opts.channelRef !== undefined && row.envelope.channel_ref !== opts.channelRef) continue;
      requests.push(row);
    }
    requests.sort((a, b) => b.receivedAt - a.receivedAt || b.cursor - a.cursor);
    const kept = requests.slice(0, limit(opts));
    const asOf = new Date(now).toISOString();
    const items = kept.map(row => {
      const { evidence } = deriveBusWorkItemEvidence(row.envelope.id, read.receipts, claims, now);
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
        owner: evidence.owner ?? null,
        claimReceipt: evidence.claimReceipt ?? null,
      };
    });
    return { items, inbox: 'ok', truncated: requests.length > kept.length };
  } catch { return empty; }
}
