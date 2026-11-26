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
import { deriveBusWorkItemEvidence, readBusClaimAuthority, readBusInboxEvidence,
  type BusClaimAuthority } from './work-item-bus-evidence.js';
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
  /** The coordination lease table's read state behind the claim veto —
   * 'unavailable' means journal claims could not be verified against the
   * shared lease authority and stand as the journal reports them. */
  coordination?: BusClaimAuthority['source'];
  /** Echo of the applied state filter; present only when `state` was given
   * and the inbox scan settled — an unreadable inbox reports neither. */
  state?: WorkItemState;
  /** The true filtered total across the whole settled scan before the
   * display cap: requests passing every applied filter — the channel_ref
   * scope, the `since`/`before` receivedAt window and the `state` match —
   * counted before the newest-first slice, so `items` may be a slice of it.
   * Present whenever `channel`, `state` or a `since`/`before` bound narrowed the read;
   * a `channelRef`-only read keeps the unfiltered shape. Never a count of
   * just the shown window. */
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

export function listWorkBoard(opts: {
  root: string; now: number; limit?: number; channel?: string; channelRef?: string; state?: WorkItemState;
  /** Epoch-ms floor on the request's recorded receivedAt — the same
   * inclusive `receivedAt >= since` rule every bus read's `--since` applies.
   * Epoch-ms bounds are self-consistent under plain comparison: a bound at
   * or below zero keeps every stored receipt, and an unparseable caller
   * value never reaches here — the CLI, MCP and API surfaces resolve the
   * shared `15m|2h|1d|epoch-ms|ISO` grammar and refuse what does not parse. */
  since?: number;
  /** Epoch-ms ceiling on the request's recorded receivedAt — the same
   * exclusive `receivedAt < before` rule every bus read's `--before`
   * applies, composing with `since` into one `[since, before)` window. */
  before?: number;
}): WorkBoardResult {
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
  // The shared lease authority every claim origin coordinates through:
  // bypass paths (seat handoffs, work-visibility, session-handoff) settle
  // coordination rows without touching this journal, so a live journal
  // claim stands only while a live message-origin twin backs it. An
  // unreadable table keeps every journal claim — unknown never erases
  // recorded evidence.
  let authority: BusClaimAuthority | undefined;
  try { authority = readBusClaimAuthority(opts.root, now); } catch { /* stays undefined: journal claims unverified */ }
  // The claims source rides every result, including a failed inbox scan:
  // during an inbox outage the board still reports whether the claims table
  // was validated-empty, missing or unreadable instead of dropping the one
  // piece of ownership evidence the inspection already produced.
  const empty: WorkBoardResult = { items: [], inbox: 'unavailable', truncated: false, claims: claimsSource,
    ...(authority === undefined ? {} : { coordination: authority.source }) };
  try {
    // One settled bounded inbox read for the whole board; an unsettled or
    // churning scan reports 'unavailable', never a partial listing.
    const read = readBusInboxEvidence(opts.root);
    if (read.status !== 'ok') return empty;
    const requests: BusInboxReceipt[] = [];
    for (const row of read.receipts) {
      if (!isRequest(row)) continue;
      if (opts.channelRef !== undefined && row.envelope.channel_ref !== opts.channelRef) continue;
      if (opts.channel !== undefined && (row.envelope.channel ?? 'bus') !== opts.channel) continue;
      // The same [since, before) window on receivedAt every bus read applies:
      // `since` keeps rows at or after the cutoff, `before` keeps rows
      // strictly before its own — a request exactly on `before` is outside.
      if (opts.since !== undefined && row.receivedAt < opts.since) continue;
      if (opts.before !== undefined && row.receivedAt >= opts.before) continue;
      requests.push(row);
    }
    requests.sort((a, b) => b.receivedAt - a.receivedAt || b.cursor - a.cursor);
    const asOf = new Date(now).toISOString();
    const toItem = (row: BusInboxReceipt): WorkBoardItem => {
      const { evidence } = deriveBusWorkItemEvidence(row.envelope.id, read.receipts, claims, now, authority);
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
    // A time bound narrows the read exactly like a state filter does, so it
    // earns the same `matched` total: the count of requests inside the
    // window before the display cap, never just the shown slice.
    const bounded = opts.channel !== undefined || opts.since !== undefined || opts.before !== undefined;
    if (opts.state === undefined) {
      const kept = requests.slice(0, limit(opts));
      return { items: kept.map(toItem), inbox: 'ok', truncated: requests.length > kept.length,
        claims: claimsSource, ...(authority === undefined ? {} : { coordination: authority.source }),
        ...(bounded ? { matched: requests.length } : {}) };
    }
    // A state filter must classify every request before the display cap so
    // `matched` is the true filtered total across the settled scan, never a
    // count of the shown window — the same honesty rule `truncated` follows.
    // The time window already narrowed `requests`, so state+window composes
    // into one filtered total for free.
    const matching = requests.map(toItem).filter(item => item.state === opts.state);
    const kept = matching.slice(0, limit(opts));
    return { items: kept, inbox: 'ok', truncated: matching.length > kept.length,
      claims: claimsSource, ...(authority === undefined ? {} : { coordination: authority.source }),
      state: opts.state, matched: matching.length };
  } catch { return empty; }
}
