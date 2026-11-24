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
import { isGroupPresenceBody } from '../fleet/bus-group.js';
import { inspectBusWorkClaims, type BusWorkClaimView, type BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
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
  /** The proof behind a VERIFIED chip or the dependency behind a BLOCKED one,
   * taken from the validated evidence reader's reply fields (never message
   * prose). Omitted for every other state. Strings are capped at 200 chars. */
  result?: WorkBoardItemResult;
}

export type WorkBoardItemResult =
  | { kind: 'verified'; pr: number | null; head: string | null; tests: string | null; artifact: string | null }
  | { kind: 'blocked'; dependency: string };

const RESULT_TEXT_MAX = 200;
const cap = (v: string | undefined): string | null => (v === undefined ? null : v.slice(0, RESULT_TEXT_MAX));

/** Result for the already-classified state; same evidence the classifier used. */
function resultFor(state: WorkItemState, evidence: ReturnType<typeof deriveBusWorkItemEvidence>['evidence']): WorkBoardItemResult | undefined {
  if (state === 'VERIFIED' && evidence.verified) {
    const v = evidence.verified;
    return { kind: 'verified', pr: v.pr ?? null, head: cap(v.head), tests: cap(v.tests), artifact: cap(v.artifact) };
  }
  if (state === 'BLOCKED' && evidence.blocker) {
    return { kind: 'blocked', dependency: evidence.blocker.dependency.slice(0, RESULT_TEXT_MAX) };
  }
  return undefined;
}

export interface WorkBoardResult {
  items: WorkBoardItem[];
  /** 'ok' when the inbox scan settled; 'unavailable' when a page failed. */
  inbox: 'ok' | 'unavailable';
  truncated: boolean;
  /** State of the claims table from the same single inspection that fed the
   * items: 'missing' (no table yet), 'available' (validated rows, possibly
   * zero) or 'unavailable' (present but unreadable/invalid). Table state is
   * never ownership evidence — an 'unavailable' table means owners are
   * unknown, not absent. Optional so hand-built fixtures still compile;
   * listWorkBoard always sets it. */
  claims?: BusWorkClaimsInspection['source'];
  /** Echo of the applied state filter; present only when `state` was given
   * and the inbox scan settled — an unreadable inbox reports neither. */
  state?: WorkItemState;
  /** Requests whose classified state equals the applied `state`, counted
   * across the whole settled scan before the display cap: the true filtered
   * total, so `items` may be a newest-first slice of it. Present only
   * alongside `state`; never a count of just the shown window. */
  matched?: number;
}

/** A request is any envelope that does not answer another message: replies
 * name their request through `inReplyTo` (bus-reply-post) or `in_reply_to`
 * (peer-protocol bodies). Both absent or null counts as a request; the body
 * is untrusted, so only these two keys are ever read. A `group.presence`
 * heartbeat is an observation with its own read (`groupPresence`), never a
 * request. */
export function isRequest(row: BusInboxReceipt): boolean {
  const body = row.envelope.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return true;
  const record = body as Record<string, unknown>;
  if (isGroupPresenceBody(record)) return false;
  if (record.kind === 'leader-reply' && typeof record.requestId === 'string') return false;
  return (record['inReplyTo'] === undefined || record['inReplyTo'] === null)
    && (record['in_reply_to'] === undefined || record['in_reply_to'] === null);
}

function limit(opts: { limit?: number }): number {
  return Number.isSafeInteger(opts.limit) && opts.limit! >= 1
    ? Math.min(opts.limit!, WORK_BOARD_MAX_LIMIT) : WORK_BOARD_DEFAULT_LIMIT;
}

export function listWorkBoard(opts: { root: string; now: number; limit?: number; channelRef?: string; state?: WorkItemState }): WorkBoardResult {
  const now = Number.isSafeInteger(opts.now) && opts.now >= 0 ? opts.now : 0;
  // One claims inspection for the whole board, taken even when the inbox
  // scan fails so the result still reports the table's real state. A missing
  // or unreadable table yields no claim rows — items still list, owners stay
  // null, and `claims` keeps 'missing'/'unavailable' distinct from a
  // validated empty table.
  let claims: BusWorkClaimView[] = [];
  let claimsSource: BusWorkClaimsInspection['source'] = 'unavailable';
  try {
    const inspection = inspectBusWorkClaims(opts.root);
    claimsSource = inspection.source;
    claims = inspection.claims;
  } catch { /* stays unavailable: no claim rows */ }
  // The claims source rides every result, including a failed inbox scan:
  // during an inbox outage the board still reports whether the claims table
  // was validated-empty, missing or unreadable instead of dropping the one
  // piece of ownership evidence the inspection already produced.
  const empty: WorkBoardResult = { items: [], inbox: 'unavailable', truncated: false, claims: claimsSource };
  try {
    // One settled bounded inbox read for the whole board; an unsettled or
    // churning scan reports 'unavailable', never a partial listing.
    const read = readBusInboxEvidence(opts.root);
    if (read.status !== 'ok') return empty;
    const requests: BusInboxReceipt[] = [];
    for (const row of read.receipts) {
      if (!isRequest(row)) continue;
      if (opts.channelRef !== undefined && row.envelope.channel_ref !== opts.channelRef) continue;
      requests.push(row);
    }
    requests.sort((a, b) => b.receivedAt - a.receivedAt || b.cursor - a.cursor);
    const asOf = new Date(now).toISOString();
    const toItem = (row: BusInboxReceipt): WorkBoardItem => {
      const { evidence } = deriveBusWorkItemEvidence(row.envelope.id, read.receipts, claims, now);
      const classified = classifyWorkItem(evidence, asOf);
      const result = resultFor(classified.state, evidence);
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
        ...(result ? { result } : {}),
      };
    };
    if (opts.state === undefined) {
      const kept = requests.slice(0, limit(opts));
      return { items: kept.map(toItem), inbox: 'ok', truncated: requests.length > kept.length, claims: claimsSource };
    }
    // A state filter must classify every request before the display cap so
    // `matched` is the true filtered total across the settled scan, never a
    // count of the shown window — the same honesty rule `truncated` follows.
    const matching = requests.map(toItem).filter(item => item.state === opts.state);
    const kept = matching.slice(0, limit(opts));
    return { items: kept, inbox: 'ok', truncated: matching.length > kept.length,
      claims: claimsSource, state: opts.state, matched: matching.length };
  } catch { return empty; }
}
