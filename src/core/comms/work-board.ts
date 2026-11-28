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
import { agentPendingAddressMatcher, agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';
import { busBodyJobMatch, busReadContains, busReadContainsMatch } from '../agents/bus-unified.js';
import { busBodyKind, busBodyResultOutcome, type WorkResultOutcome } from '../agents/bus-v2-schema.js';
import type { BusPriority } from '../fleet/bus-envelope.js';
import { groupAddressTopicOf, isGroupPresenceBody } from '../fleet/bus-group.js';
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
  /** Raw sender routing label of the request envelope — untrusted data,
   * never authenticated identity. Optional so hand-built fixtures still
   * compile; listWorkBoard always sets it. */
  from?: string;
  /** Raw recipient routing label of the request envelope (`agent:<handle>`,
   * a bare label or a `group:<channel>:<topic>` address) — untrusted data,
   * never authenticated identity. Optional so hand-built fixtures still
   * compile; listWorkBoard always sets it. */
  to?: string;
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
   * scope, the `since`/`before` receivedAt window, the `channel`/`topic`/`id`
   * address filters, the sender/recipient/priority/body filters and the
   * `state` match —
   * counted before the newest-first slice, so `items` may be a slice of it.
   * Present whenever `state`, a `since`/`before` bound or one of the
   * narrowing filters applied; a `channelRef`-only read keeps the
   * unfiltered shape. Never a count of just the shown window. */
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
  root: string; now: number; limit?: number; channelRef?: string; state?: WorkItemState;
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
  /** Bus channel name whose `group:<name>:*` traffic is kept — the same
   * raw `to`-prefix rule every bus read's `--channel` applies, decided on
   * each request envelope's own `to` label with no registry dependence:
   * an agent address, a bare `group:<room>` or a malformed group label
   * simply never matches, so unknown address state never widens the
   * filter. Callers validate the strict channel-name grammar; a value
   * that reaches here unmatched is an honest empty match, never an error.
   * Composes with `topic` into one room AND one topic. */
  channel?: string;
  /** Exact topic component a well-formed `group:<room>:<topic>` `to` must
   * carry — the same `groupAddressTopicOf` match every bus read's
   * `--topic` applies, decided on the request envelope's own `to` label
   * with no registry dependence and composing with `channel` into one
   * room AND one topic exactly as every other bus read's channel/topic
   * pair applies. */
  topic?: string;
  /** Keep only the request whose own wire id is strictly equal — the same
   * exact-envelope match every bus read's `--id` applies and the id
   * `agents bus show <id>` resolves, decided on the retained envelope id
   * alone. */
  id?: string;
  /** Keep only requests addressed to this agent — the shared
   * `agentPendingAddressMatcher` rule `bus next` claims by: the literal
   * `to` label, any label of the identity the ref resolves to through the
   * bus registry, or a member channel's `group:<name>:` address, minus
   * channel posts the identity sent itself. The registry is read only when
   * an address ref is present; an unresolvable ref or an unreadable
   * registry keeps exact-label matching, so unknown identity state never
   * widens the filter. Callers validate the printable routing-label
   * grammar; a value that reaches here unmatched is an honest empty match,
   * never an error. */
  to?: string;
  /** Keep only requests whose `from` label the ref matches — the shared
   * `agentRefAddressMatcher` rule every bus read's `--from` applies: the
   * literal label or any other label of the identity it resolves to,
   * exact-label matching kept on an unresolvable ref or unreadable
   * registry. */
  from?: string;
  /** Drop requests whose `from` label the ref matches, under the same
   * `agentRefAddressMatcher` identity-label rule `from` applies — a sender
   * both included and excluded matches nothing. */
  excludeFrom?: string;
  /** Keep only requests stamped with this exact P0..P3 band — the same
   * `envelope.priority` equality every bus read's `--priority` applies. */
  priority?: BusPriority;
  /** Keep only requests whose body names this one job — the shared
   * `busBodyJobMatch` rule every bus read's `--job` applies: a
   * feed-citing body's own `jobId`, a `worker-handoff` `taskId`, or a
   * `job:<id>` v2 thread label on a note/context body. */
  job?: string;
  /** Keep only requests whose body carries this exact kind discriminator —
   * the shared `busBodyKind` own-field match every bus read's `--body-kind`
   * applies (the v2 `kind` field, a `worker-handoff`/`protocol.kind`/
   * `type`/`schema` fallback), case-sensitive; a body carrying no
   * discriminator never matches. */
  bodyKind?: string;
  /** Keep only requests whose body is a `work.result` receipt reporting
   * this one outcome — the shared `busBodyResultOutcome` own-field match
   * every bus read's `--result` applies over the WORK_RESULT_OUTCOMES
   * vocabulary; every other body kind and a result carrying no outcome
   * never matches. */
  result?: WorkResultOutcome;
  /** Keep only requests whose scrubbed one-line summary carries this
   * needle as a case-insensitive substring — the shared
   * `busReadContainsMatch` rule every bus read's `--contains` applies,
   * matching the rendered summary, never the raw body, so a secret-shaped
   * value stays unfindable. `opts.contains` arrives as the caller spelled
   * it; the read normalizes through `busReadContains` itself, and callers
   * validate the bounded non-blank grammar first — an invalid value
   * reaching here is ignored like every other surface's pre-validated
   * filter, never a widened match. */
  contains?: string;
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
    // The shared bus-read address matchers resolve once per read, and only
    // when an address ref is present: the registry sits beside the bus
    // store under the same root, an unresolvable ref or an unreadable
    // registry keeps exact-label matching, so unknown identity state never
    // widens the board. `to` takes the pending-address rule `bus next`
    // claims by; `from`/`excludeFrom` the sender-label rule every bus
    // read's sender filters share.
    const registry = opts.to === undefined && opts.from === undefined && opts.excludeFrom === undefined
      ? undefined
      : (() => { const r = readAgentRegistry({ root: opts.root }); return r.status === 'ok' ? r.registry : undefined; })();
    const addressedTo = opts.to === undefined ? undefined : agentPendingAddressMatcher(opts.to, registry);
    const fromMatch = opts.from === undefined ? undefined : agentRefAddressMatcher(opts.from, registry);
    const excludeFromMatch = opts.excludeFrom === undefined ? undefined : agentRefAddressMatcher(opts.excludeFrom, registry);
    // The caller validated the needle grammar; the read still normalizes
    // through the shared `busReadContains` rule so the match compares the
    // same normalized form every other bus read applies.
    const containsNeedle = busReadContains(opts.contains) ?? undefined;
    const requests: BusInboxReceipt[] = [];
    const channelPrefix = opts.channel === undefined ? undefined : `group:${opts.channel}:`;
    for (const row of read.receipts) {
      if (!isRequest(row)) continue;
      if (opts.channelRef !== undefined && row.envelope.channel_ref !== opts.channelRef) continue;
      // The same [since, before) window on receivedAt every bus read applies:
      // `since` keeps rows at or after the cutoff, `before` keeps rows
      // strictly before its own — a request exactly on `before` is outside.
      if (opts.since !== undefined && row.receivedAt < opts.since) continue;
      if (opts.before !== undefined && row.receivedAt >= opts.before) continue;
      // The room, topic and wire-id filters decide on the request
      // envelope's own `to`/`id` fields — the same raw-label rules every
      // bus read's --channel/--topic/--id applies, registry-free so an
      // unresolvable or absent address simply never matches.
      if (channelPrefix !== undefined && !row.envelope.to.startsWith(channelPrefix)) continue;
      if (opts.topic !== undefined && groupAddressTopicOf(row.envelope.to) !== opts.topic) continue;
      if (opts.id !== undefined && row.envelope.id !== opts.id) continue;
      // The shared sender/recipient, band and body filters — the same
      // per-envelope rules `busThreadRowFilter` and `busPageRowMatch`
      // apply, decided on the request envelope's own fields.
      if (addressedTo !== undefined && !addressedTo(row.envelope.to, row.envelope.from)) continue;
      if (fromMatch !== undefined && !fromMatch(row.envelope.from)) continue;
      if (excludeFromMatch !== undefined && excludeFromMatch(row.envelope.from)) continue;
      if (opts.priority !== undefined && row.envelope.priority !== opts.priority) continue;
      if (opts.job !== undefined && !busBodyJobMatch(row.envelope.body, opts.job)) continue;
      if (opts.bodyKind !== undefined && busBodyKind(row.envelope.body) !== opts.bodyKind) continue;
      if (opts.result !== undefined && busBodyResultOutcome(row.envelope.body) !== opts.result) continue;
      if (containsNeedle !== undefined && !busReadContainsMatch(row.envelope.body, containsNeedle)) continue;
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
        from: row.envelope.from,
        to: row.envelope.to,
        ...(result ? { result } : {}),
      };
    };
    // A narrowing filter — a time bound, one of the address filters or one
    // of the shared sender/recipient, band and body filters — narrows the
    // read exactly like a state filter does, so it earns the same `matched`
    // total: the count of requests inside the window before the display
    // cap, never just the shown slice.
    const bounded = opts.since !== undefined || opts.before !== undefined
      || opts.channel !== undefined || opts.topic !== undefined || opts.id !== undefined
      || opts.to !== undefined || opts.from !== undefined || opts.excludeFrom !== undefined
      || opts.priority !== undefined || opts.job !== undefined
      || opts.bodyKind !== undefined || opts.result !== undefined || opts.contains !== undefined;
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
