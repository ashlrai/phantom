/**
 * Post-admission read filters for `phm comms bus group read` — the same shared
 * bus-read rules every other surface applies, scoped to the one
 * `group:<room>:<topic>` page a subscription cursor already admits. Filtering
 * is a view of the page, never a subscription: `nextCursor` still advances
 * over every scanned row, so an unfiltered poll sees everything and no filter
 * can widen what the address admits. `from`/`excludeFrom` resolve through the
 * agent identity registry exactly like `comms bus read|watch` — an
 * unresolvable ref or unreadable registry keeps exact-label matching, so
 * unknown identity state never widens a page. Group labels stay routing
 * labels, not identities: nothing here authenticates a sender or grants
 * authority.
 */
import { BUS_PRIORITIES, type BusPriority } from './bus-envelope.js';
import type { BusInboxOptions, BusInboxPage, BusInboxReceipt } from './bus-inbox.js';
import { subscribeGroup } from './bus-group.js';
import { parseSince } from './agent-messages.js';
import { agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';
import { busBodyInReplyToMatch, busBodyJobMatch, busReadContains, busReadContainsMatch } from '../agents/bus-unified.js';
import { busBodyKind, busBodyResultOutcome, busBodyThread,
  WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../agents/bus-v2-schema.js';

/** The printable-label bound every bus read applies to id/label filter values. */
const LABEL = /^[\x21-\x7e]{1,128}$/;

/** Raw flag values `phm comms bus group read` collects; every field is a string until parsed. */
export interface GroupReadFilterInput {
  id?: string;
  inReplyTo?: string;
  from?: string;
  excludeFrom?: string;
  priority?: string;
  thread?: string;
  job?: string;
  bodyKind?: string;
  result?: string;
  /** `15m`, `2h`, `1d`, epoch ms or an ISO time — the shared parseSince grammar. */
  since?: string;
  before?: string;
  contains?: string;
}

/** Resolved address predicates; each is present exactly when its sender filter is. */
export interface GroupReadAddressMatchers {
  from?: (value: string) => boolean;
  excludeFrom?: (value: string) => boolean;
}

/** The parsed own-field and row filters; absent fields never narrow the page. */
export interface GroupReadFilters {
  /** Exact envelope-id match, case-sensitive. */
  id?: string;
  /** Own-property `body.inReplyTo` exact match — the shared reply-citation rule. */
  inReplyTo?: string;
  /** Exact P0..P3 envelope band. */
  priority?: BusPriority;
  /** The v2 thread label a `note`/`context` body carries; every other kind never matches. */
  thread?: string;
  /** The shared `busBodyJobMatch` rule: a jobId citation or the `job:<id>` thread label. */
  job?: string;
  /** Exact body-kind discriminator — `group.message`, `group.presence`, `note`, `work.result`, … */
  bodyKind?: string;
  /** The outcome a `work.result` body reports; every other kind never matches. */
  result?: WorkResultOutcome;
  /** Inclusive lower bound on `receivedAt`, epoch ms. */
  since?: number;
  /** Exclusive upper bound on `receivedAt`, epoch ms; composes with `since` into `[since, before)`. */
  before?: number;
  /** Normalized case-insensitive needle matched against the shared scrubbed body summary. */
  contains?: string;
}

export type GroupReadQuery = {
  ok: true;
  filters: GroupReadFilters;
  /** The validated sender labels, resolved to predicates by `groupReadAddressMatchers`. */
  senders: { from?: string; excludeFrom?: string };
} | { ok: false };

/**
 * Shared validation for the CLI flags; `now` anchors the relative time grammar
 * once per read. Every field applies the same rule the matching `comms bus
 * read|watch` flag applies — an unknown priority band, result outcome, body
 * kind or time value is a usage error (`ok:false`), never a silently empty
 * page.
 */
export function parseGroupReadFilters(input: GroupReadFilterInput, now = Date.now()): GroupReadQuery {
  const filters: GroupReadFilters = {};
  const senders: { from?: string; excludeFrom?: string } = {};
  for (const key of ['id', 'inReplyTo', 'thread', 'job', 'bodyKind'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!LABEL.test(value)) return { ok: false };
    filters[key] = value;
  }
  for (const key of ['from', 'excludeFrom'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!LABEL.test(value)) return { ok: false };
    senders[key] = value;
  }
  if (input.priority !== undefined) {
    if (!(BUS_PRIORITIES as readonly string[]).includes(input.priority)) return { ok: false };
    filters.priority = input.priority as BusPriority;
  }
  if (input.result !== undefined) {
    // The same WORK_RESULT_OUTCOMES enum every other bus read's --result
    // validates, so the flag can never disagree about which codes a
    // work.result body can report.
    if (!(WORK_RESULT_OUTCOMES as readonly string[]).includes(input.result)) return { ok: false };
    filters.result = input.result as WorkResultOutcome;
  }
  for (const key of ['since', 'before'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const ms = parseSince(value, now);
    if (ms === null || !Number.isSafeInteger(ms) || ms < 0) return { ok: false };
    filters[key] = ms;
  }
  const needle = busReadContains(input.contains);
  if (needle === null) return { ok: false };
  if (needle !== undefined) filters.contains = needle;
  return { ok: true, filters, senders };
}

/**
 * One admitted group-addressed row against the parsed filters — every check is
 * an exact own-field or shared-projection match, the same rules `comms bus
 * read|watch` and `agents bus channel read` apply, so a filtered group read
 * can never disagree with them about what a filter means. `since`/`before`
 * compose one `[since, before)` window on `receivedAt`; `contains` matches the
 * shared scrubbed one-line summary; `bodyKind` reads the same discriminator
 * `busBodySummary` switches on, so `group.presence` heartbeats and
 * `group.message` posts are separable by the body's own kind.
 */
export function groupReadRowMatches(row: BusInboxReceipt, filters: GroupReadFilters,
  addresses: GroupReadAddressMatchers = {}): boolean {
  const { envelope, receivedAt } = row;
  if (filters.id !== undefined && envelope.id !== filters.id) return false;
  if (filters.inReplyTo !== undefined && !busBodyInReplyToMatch(envelope.body, filters.inReplyTo)) return false;
  if (addresses.from !== undefined && !addresses.from(envelope.from)) return false;
  if (addresses.excludeFrom !== undefined && addresses.excludeFrom(envelope.from)) return false;
  if (filters.priority !== undefined && envelope.priority !== filters.priority) return false;
  if (filters.thread !== undefined && busBodyThread(envelope.body) !== filters.thread) return false;
  if (filters.job !== undefined && !busBodyJobMatch(envelope.body, filters.job)) return false;
  if (filters.bodyKind !== undefined && busBodyKind(envelope.body) !== filters.bodyKind) return false;
  if (filters.result !== undefined && busBodyResultOutcome(envelope.body) !== filters.result) return false;
  if (filters.since !== undefined && receivedAt < filters.since) return false;
  if (filters.before !== undefined && receivedAt >= filters.before) return false;
  if (filters.contains !== undefined && !busReadContainsMatch(envelope.body, filters.contains)) return false;
  return true;
}

/**
 * Resolve the sender labels once per read through the agent identity registry
 * — the same one-read rule `comms bus read|watch --from|--exclude-from` and
 * `agents bus channel read` apply: a ref resolving to a registered identity
 * matches every label of that identity, an unresolvable ref or unreadable
 * registry keeps exact-label matching, so unknown identity state never widens
 * a page. Called only when a sender filter is present, so an unfiltered read
 * never touches the registry.
 */
export function groupReadAddressMatchers(senders: { from?: string; excludeFrom?: string },
  options: BusInboxOptions): GroupReadAddressMatchers {
  if (senders.from === undefined && senders.excludeFrom === undefined) return {};
  const read = readAgentRegistry({ root: options.root });
  const registry = read.status === 'ok' ? read.registry : undefined;
  const matchers: GroupReadAddressMatchers = {};
  if (senders.from !== undefined) matchers.from = agentRefAddressMatcher(senders.from, registry);
  if (senders.excludeFrom !== undefined) matchers.excludeFrom = agentRefAddressMatcher(senders.excludeFrom, registry);
  return matchers;
}

/**
 * One page of a `group:<room>:<topic>` subscription with the shared read
 * filters applied — the same page `subscribeGroup` returns, narrowed. With no
 * filter values the raw page passes through untouched; with any, the page's
 * `nextCursor` still covers every scanned row so the filtered view never
 * stalls a poll. An invalid room/topic, cursor or filter value reports
 * `invalid`, the same status an unfiltered bad read reports.
 */
export function readGroupTopic(room: string, topic: string, after: number, limit: number,
  input: GroupReadFilterInput, options: BusInboxOptions = {}): BusInboxPage {
  const query = parseGroupReadFilters(input, (options.now ?? Date.now)());
  if (!query.ok) return { status: 'invalid' };
  const filtered = Object.values(query.filters).some(value => value !== undefined) ||
    query.senders.from !== undefined || query.senders.excludeFrom !== undefined;
  const page = subscribeGroup(room, topic, after, limit, options);
  if (page.status !== 'ok' || !filtered) return page;
  const addresses = groupReadAddressMatchers(query.senders, options);
  return { ...page, messages: page.messages.filter(row => groupReadRowMatches(row, query.filters, addresses)) };
}
