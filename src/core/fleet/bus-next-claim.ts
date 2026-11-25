/** One-shot local coordination; message labels do not authenticate or authorize execution. */
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxReceipt } from './bus-inbox.js';
import { BUS_PRIORITIES, isClaimableWork, type BusPriority } from './bus-envelope.js';
import { mutateBusWorkClaim, validBusClaimRequest } from './bus-work-claims.js';
import { agentChannelNameSchema, agentPendingAddressMatcher, agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';
import { busBodyInReplyToMatch, busReadContains, busReadContainsMatch } from '../agents/bus-unified.js';
import { busBodyKind } from '../agents/bus-v2-schema.js';

/** Printable routing labels — the same 1-128 char grammar every bus address and read filter carries. */
const label = (value: string): boolean => /^[\x21-\x7e]{1,128}(?![\s\S])/.test(value);

export interface BusNextRequest {
  to: string; owner: string; leaseMs: number; root?: string;
  /** Keep only receipts whose scrubbed one-line summary carries this text —
   * the same `busReadContains`/`busReadContainsMatch` rule every bus read's
   * `--contains` applies, so "claim the next work about X" is one atomic
   * step instead of a filtered list followed by a claim-by-id. */
  contains?: string;
  /** Keep only receipts received at or after this epoch-ms cutoff — the same
   * inclusive `receivedAt >= since` rule `agents bus inbox --since` applies. */
  since?: number;
  /** Keep only receipts received strictly before this epoch-ms cutoff — the
   * exclusive upper bound composing with `since` into one `[since, before)`
   * window, the same `receivedAt < before` rule every bus read's `--before`
   * applies, so the claim can take exactly the slice a bounded read showed
   * and never pick work newer than the window the claimant reviewed. */
  before?: number;
  /** Keep only envelopes in this priority band — the same exact-band match
   * every bus read's `--priority` applies. Ordering already prefers P0, so
   * this narrows the claimable set rather than reordering it. */
  priority?: BusPriority;
  /** Keep only receipts addressed to `group:<name>:*` of one bus channel —
   * the same raw `to`-prefix rule every bus read's `--channel` applies,
   * decided on the address label with no registry dependence, so "claim the
   * next work in channel X" narrows the claimable set to one room's topics
   * the same way `work mine --channel` narrows its next section. */
  channel?: string;
  /** Keep only receipts one sender wrote — the same `agentRefAddressMatcher`
   * identity-label rule every bus read's `--from` applies: a ref resolving
   * through the registry matches every label of that identity, an
   * unresolvable ref or unreadable registry keeps exact-label matching, so
   * unknown identity state never widens the claim. */
  from?: string;
  /** Drop receipts sent under every registered spelling of one identity —
   * the same sender-exclusion rule every bus read's `--exclude-from`
   * applies; it composes with `from` (a sender both included and excluded
   * matches nothing). */
  excludeFrom?: string;
  /** Keep only receipts whose object body cites this envelope id through its
   * own `inReplyTo` field — the same own-property exact match every bus
   * read's `--in-reply-to` applies. The citation is an application
   * convention on the body, not an envelope field, and claimable
   * `kind:'work'`/protocol `task` bodies carry it like any other object
   * body, so "claim the work answering envelope X" is one atomic step
   * instead of a filtered inbox page followed by a claim-by-id. */
  inReplyTo?: string;
  /** Keep only receipts whose body carries this exact kind discriminator —
   * the same `busBodyKind` match every bus read's `--body-kind` applies.
   * On the claimable set it separates the two real shapes: `work` for the
   * legacy `{kind:'work'}` convention and `task` for a bus-transport v1
   * protocol task, so an agent that only executes one shape never claims
   * the other. An unrecognized but printable value is an honest empty
   * match, never an error. */
  bodyKind?: string;
}
/** `empty` still means no receipt could be claimed, but now carries the honest
 * scan totals so a caller can tell a dry well from held work without a second
 * read: `candidates` is every live claimable envelope addressed to `--to` the
 * bounded scan found that also satisfies the request's `contains`/`since`/
 * `before`/`priority`/`channel`/`from`/`excludeFrom`/`inReplyTo`/`bodyKind`
 * filters, and `held` is how many of those answered `conflict` — a
 * live claim on the message id or an overlapping coordination key, which may
 * be the requester's own prior claim. `candidates - held` failed acquire for
 * other reasons (completed, expired, lost, missing, or a receipt that changed
 * mid-claim); expired envelopes never reach the scan, so they are not
 * candidates. Both counts are observed over the filtered scan, never
 * estimated. */
export type BusNextResult = { status: 'acquired'; receipt: BusInboxReceipt; token: string; leaseUntil: number }
  | { status: 'empty'; candidates: number; held: number }
  | { status: string };

/**
 * `--to` claims for one agent identity under every routing label that
 * resolves to it — handle, `agent:` address, stable id or alias — or for a
 * `group:<channel>:<topic>` address of a registry channel the identity
 * belongs to, minus the identity's own channel posts: the same membership
 * rule the inbox, wakes and the `work mine` digest's next section apply, so
 * work the digest lists as pending is claimable under the agent's own ref. A
 * `--to` that names no registered identity (a topic such as `fleet.deploy`),
 * membership in no channel and an unreadable registry all keep exact-label
 * matching, so unknown identity state never widens a claim. The `from` and
 * `excludeFrom` sender filters resolve through the same one registry read
 * with `agentRefAddressMatcher` — the rule every bus read's sender filters
 * share — so an unresolvable ref or unreadable registry keeps exact-label
 * matching there too.
 */
function claimAddressMatchers(request: BusNextRequest): {
  addressedTo: (to: string, from: string) => boolean;
  from?: (value: string) => boolean;
  excludeFrom?: (value: string) => boolean;
} {
  const read = readAgentRegistry({ root: request.root });
  const registry = read.status === 'ok' ? read.registry : undefined;
  return {
    addressedTo: agentPendingAddressMatcher(request.to, registry),
    ...(request.from === undefined ? {} : { from: agentRefAddressMatcher(request.from, registry) }),
    ...(request.excludeFrom === undefined ? {} : { excludeFrom: agentRefAddressMatcher(request.excludeFrom, registry) }),
  };
}

export function claimNextBusWork(request: BusNextRequest): BusNextResult {
  const claim = { action: 'acquire' as const, id: request.to, owner: request.owner, leaseMs: request.leaseMs, root: request.root };
  if (!validBusClaimRequest(claim)) return { status: 'invalid' };
  const containsNeedle = busReadContains(request.contains);
  if (containsNeedle === null) return { status: 'invalid' };
  if (request.since !== undefined && (!Number.isSafeInteger(request.since) || request.since < 0)) return { status: 'invalid' };
  if (request.before !== undefined && (!Number.isSafeInteger(request.before) || request.before < 0)) return { status: 'invalid' };
  if (request.priority !== undefined && !BUS_PRIORITIES.includes(request.priority)) return { status: 'invalid' };
  if (request.channel !== undefined && !agentChannelNameSchema.safeParse(request.channel).success) return { status: 'invalid' };
  if (request.from !== undefined && !label(request.from)) return { status: 'invalid' };
  if (request.excludeFrom !== undefined && !label(request.excludeFrom)) return { status: 'invalid' };
  if (request.inReplyTo !== undefined && !label(request.inReplyTo)) return { status: 'invalid' };
  if (request.bodyKind !== undefined && !label(request.bodyKind)) return { status: 'invalid' };
  const matchers = claimAddressMatchers(request);
  const channelPrefix = request.channel === undefined ? undefined : `group:${request.channel}:`;
  const candidates: BusInboxReceipt[] = [];
  let cursor = 0, scanned = 0, finished = false;
  // An extra page is needed when a full page ends exactly at the high-water mark.
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: request.root });
    if (result.status !== 'ok') return { status: result.status };
    scanned += result.messages.length;
    if (scanned > BUS_INBOX_MAX_MESSAGES || result.nextCursor < cursor) return { status: 'retryable' };
    for (const receipt of result.messages) {
      // The read filters every bus surface shares apply to the claimable set
      // the same way: `since` is the inclusive receivedAt cutoff, `before` the
      // exclusive upper bound composing with it into one [since, before)
      // window, `priority` the exact band, `channel` the raw group:<name>:
      // to-prefix, `from`/`excludeFrom` the sender identity-label match, and
      // `contains` the scrubbed one-line summary — so a filtered claim can
      // never pick work the matching read would hide, including work newer
      // than its window. `inReplyTo` and `bodyKind` are the two remaining
      // shared read filters a claimable body can actually carry: the
      // own-property `inReplyTo` citation any object body may hold, and the
      // `busBodyKind` discriminator that separates the legacy `work` shape
      // from a protocol `task`. The other citation filters (job, thread,
      // protocol kind/topic) stay off: claimable bodies carry none of those
      // citations — a `kind:'work'` body is no feed-citing kind and no
      // note/context, and a protocol task's topic must equal its `to` — so
      // they could only ever narrow to nothing.
      if (matchers.addressedTo(receipt.envelope.to, receipt.envelope.from) && isClaimableWork(receipt.envelope.body) &&
          (request.since === undefined || receipt.receivedAt >= request.since) &&
          (request.before === undefined || receipt.receivedAt < request.before) &&
          (request.priority === undefined || receipt.envelope.priority === request.priority) &&
          (channelPrefix === undefined || receipt.envelope.to.startsWith(channelPrefix)) &&
          (matchers.from === undefined || matchers.from(receipt.envelope.from)) &&
          (matchers.excludeFrom === undefined || !matchers.excludeFrom(receipt.envelope.from)) &&
          (request.inReplyTo === undefined || busBodyInReplyToMatch(receipt.envelope.body, request.inReplyTo)) &&
          (request.bodyKind === undefined || busBodyKind(receipt.envelope.body) === request.bodyKind) &&
          (containsNeedle === undefined || busReadContainsMatch(receipt.envelope.body, containsNeedle))) {
        candidates.push(receipt);
      }
    }
    if (result.messages.length < BUS_INBOX_MAX_READ) { finished = true; break; }
    if (result.nextCursor <= cursor) return { status: 'retryable' };
    cursor = result.nextCursor;
  }
  if (!finished) return { status: 'retryable' };
  candidates.sort((a, b) => BUS_PRIORITIES.indexOf(a.envelope.priority) - BUS_PRIORITIES.indexOf(b.envelope.priority) || a.cursor - b.cursor);
  let held = 0;
  for (const candidate of candidates) {
    const result = mutateBusWorkClaim({ ...claim, id: candidate.envelope.id });
    if (result.status === 'acquired' && result.token && result.leaseUntil !== undefined) {
      // The ID can have been reclaimed while scanning. Return only the same live
      // receipt that was selected, never an old body paired with a new lease.
      const current = listBusInboxAfter(candidate.cursor - 1, 1, { root: request.root });
      const row = current.status === 'ok' ? current.messages[0] : undefined;
      const { ttl: _ttl, ...selectedEnvelope } = candidate.envelope;
      const { ttl: _currentTtl, ...currentEnvelope } = row?.envelope ?? candidate.envelope;
      if (current.status === 'ok' && Date.now() < result.leaseUntil && row?.cursor === candidate.cursor && row.receivedAt === candidate.receivedAt &&
          JSON.stringify(selectedEnvelope) === JSON.stringify(currentEnvelope)) {
        return { status: 'acquired', receipt: row, token: result.token, leaseUntil: result.leaseUntil };
      }
      const released = mutateBusWorkClaim({ action: 'release', id: candidate.envelope.id, token: result.token, root: request.root });
      if (current.status !== 'ok') return { status: current.status };
      if (!['released', 'lost', 'missing', 'expired', 'mismatched-token'].includes(released.status)) return { status: released.status };
      continue;
    }
    if (['conflict', 'completed', 'expired', 'lost', 'missing'].includes(result.status)) {
      if (result.status === 'conflict') held += 1;
      continue;
    }
    return { status: result.status === 'acquired' ? 'unavailable' : result.status };
  }
  return { status: 'empty', candidates: candidates.length, held };
}
