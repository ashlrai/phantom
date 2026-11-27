/**
 * The shared durable-bus page filter set. `phm comms bus read|watch`, the
 * fleet MCP `fleet_bus_inbox` read and the verse `GET /api/verse/agent-bus`
 * raw page all scan the same `listBusInboxAfter` page; this module owns the
 * one filter shape, the one address-matcher resolution and the one row
 * predicate so those reads can never disagree about what a filter keeps.
 * Routing labels are data resolved through the agent identity registry —
 * an unresolvable ref or an unreadable registry keeps exact-label matching,
 * so unknown identity state never widens a page. `since`/`before` are
 * epoch-ms cutoffs on each receipt's `receivedAt` ([since, before) window);
 * `contains` is the normalized needle `busReadContains` returns. The limit
 * counts scanned live records before filtering: an unmatched page still
 * advances `nextCursor`, and filters never fabricate rows.
 */
import { agentChannelNameSchema, agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';
import { busBodyInReplyToMatch, busBodyJobMatch, busReadContains, busReadContainsMatch } from '../agents/bus-unified.js';
import { busBodyKind, busBodyResultOutcome, busBodyThread, WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../agents/bus-v2-schema.js';
import { parseSince } from './agent-messages.js';
import { BUS_INBOX_MAX_READ, type BusInboxPage, type BusInboxReceipt } from './bus-inbox.js';
import {
  BUS_PRIORITIES, BUS_PROTOCOL_KINDS, isTopicPattern, protocolOf, topicMatches,
  validateBusEnvelope, type BusPriority, type BusProtocolKind,
} from './bus-envelope.js';

/** Raw address refs as the caller spelled them; each resolves to a matcher. */
export interface BusPageAddressRefs {
  /** Recipient routing label; matches every label of one registered identity. */
  to?: string;
  /** Sender routing label; matches every label of one registered identity. */
  from?: string;
  /** Sender routing label excluded under the same identity-label rule. */
  excludeFrom?: string;
}

/** The scalar and body filters every bus page read shares. */
export interface BusPageFilters {
  /** Exact envelope wire id. */
  id?: string;
  /** Exact `inReplyTo` field on object bodies. */
  inReplyTo?: string;
  /** Exact P0..P3 priority band. */
  priority?: BusPriority;
  /** Protocol-v1 body kind (task, result, review, status, question). */
  kind?: BusProtocolKind;
  /** Topic name or namespace prefix the body's protocol topic must match. */
  topic?: string;
  /** v2 thread label — matches `note`/`context` bodies only. */
  thread?: string;
  /** One job id the body must name (the shared `busBodyJobMatch` rule). */
  job?: string;
  /** Room filter: keeps only envelopes addressed to `group:<channel>:*`. */
  channel?: string;
  /** Exact body-kind discriminator the body must carry (the shared
   * `busBodyKind` own-field match), case-sensitive. */
  bodyKind?: string;
  /** `work.result` outcome code the `busBodyResultOutcome` own-field match reads. */
  result?: WorkResultOutcome;
  /** Epoch-ms cutoff; keeps `receivedAt >= since`. */
  since?: number;
  /** Epoch-ms cutoff; keeps `receivedAt < before` — the exclusive upper bound. */
  before?: number;
  /** Normalized `contains` needle over the scrubbed one-line summary. */
  contains?: string;
}

/** Resolved address predicates; each is present exactly when its ref is. */
export interface BusPageMatchers {
  to?: (value: string) => boolean;
  from?: (value: string) => boolean;
  excludeFrom?: (value: string) => boolean;
}

/**
 * Address refs resolve once per read through the agent identity registry
 * beside the bus store: a ref naming any label of a registered identity
 * matches every label of that identity. The registry is read only when at
 * least one ref is present; an unresolvable ref or an unreadable registry
 * keeps exact-label matching, so unknown identity state never widens a page.
 */
export function busPageAddressMatchers(refs: BusPageAddressRefs, options: { root?: string } = {}): BusPageMatchers {
  const matchers: BusPageMatchers = {};
  if (refs.to === undefined && refs.from === undefined && refs.excludeFrom === undefined) return matchers;
  const read = readAgentRegistry({ root: options.root });
  const registry = read.status === 'ok' ? read.registry : undefined;
  if (refs.to !== undefined) matchers.to = agentRefAddressMatcher(refs.to, registry);
  if (refs.from !== undefined) matchers.from = agentRefAddressMatcher(refs.from, registry);
  if (refs.excludeFrom !== undefined) matchers.excludeFrom = agentRefAddressMatcher(refs.excludeFrom, registry);
  return matchers;
}

/** One scanned receipt against the resolved filter set — the single row rule. */
export function busPageRowMatch(row: BusInboxReceipt, filters: BusPageFilters, matchers: BusPageMatchers = {}): boolean {
  const { envelope, receivedAt } = row;
  const channelPrefix = filters.channel === undefined ? undefined : `group:${filters.channel}:`;
  return (filters.id === undefined || envelope.id === filters.id) &&
    (filters.inReplyTo === undefined || busBodyInReplyToMatch(envelope.body, filters.inReplyTo)) &&
    (matchers.to === undefined || matchers.to(envelope.to)) &&
    (channelPrefix === undefined || envelope.to.startsWith(channelPrefix)) &&
    (matchers.from === undefined || matchers.from(envelope.from)) &&
    (matchers.excludeFrom === undefined || !matchers.excludeFrom(envelope.from)) &&
    (filters.priority === undefined || envelope.priority === filters.priority) &&
    (filters.kind === undefined || protocolOf(envelope.body)?.kind === filters.kind) &&
    (filters.topic === undefined || topicMatches(filters.topic, protocolOf(envelope.body)?.topic ?? '')) &&
    (filters.thread === undefined || busBodyThread(envelope.body) === filters.thread) &&
    (filters.job === undefined || busBodyJobMatch(envelope.body, filters.job)) &&
    (filters.bodyKind === undefined || busBodyKind(envelope.body) === filters.bodyKind) &&
    (filters.result === undefined || busBodyResultOutcome(envelope.body) === filters.result) &&
    (filters.since === undefined || receivedAt >= filters.since) &&
    (filters.before === undefined || receivedAt < filters.before) &&
    (filters.contains === undefined || busReadContainsMatch(envelope.body, filters.contains));
}

function anyFilterSet(filters: BusPageFilters, matchers: BusPageMatchers): boolean {
  return Object.values(filters).some(value => value !== undefined) ||
    matchers.to !== undefined || matchers.from !== undefined || matchers.excludeFrom !== undefined;
}

/**
 * Narrow one scanned page to the rows every filter keeps. `nextCursor` is
 * the underlying page's own resume point — filters narrow the shown rows,
 * never the scan — and a page carrying no filter at all returns unchanged.
 */
export function filterBusInboxPage(page: BusInboxPage, filters: BusPageFilters, matchers: BusPageMatchers = {}): BusInboxPage {
  if (page.status !== 'ok' || !anyFilterSet(filters, matchers)) return page;
  return { ...page, messages: page.messages.filter(row => busPageRowMatch(row, filters, matchers)) };
}

/** The query keys the raw bus page read accepts, in documentation order. */
export const BUS_PAGE_QUERY_PARAMS = [
  'after', 'limit', 'to', 'from', 'excludeFrom', 'id', 'inReplyTo',
  'priority', 'kind', 'topic', 'thread', 'job', 'channel', 'bodyKind',
  'result', 'since', 'before', 'contains',
] as const;

/** String-valued query input — one entry per `BUS_PAGE_QUERY_PARAMS` key. */
export interface BusPageQueryInput {
  after?: string;
  limit?: string;
  to?: string;
  from?: string;
  excludeFrom?: string;
  id?: string;
  inReplyTo?: string;
  priority?: string;
  kind?: string;
  topic?: string;
  thread?: string;
  job?: string;
  channel?: string;
  bodyKind?: string;
  result?: string;
  since?: string;
  before?: string;
  contains?: string;
}

export type BusPageQueryResult =
  | { ok: true; after: number; limit: number; refs: BusPageAddressRefs; filters: BusPageFilters }
  | { ok: false; error: string };

/** The bus envelope id grammar every label field shares: printable ASCII, 1..128. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;
/** The cursor grammar the raw page has always taken: canonical decimal, no sign or padding. */
const CURSOR = /^(0|[1-9][0-9]*)$/;

/**
 * Routing labels use the bus wire contract: printable ASCII tokens of
 * 1..128 characters (the same dummy-envelope check `phm comms bus read`
 * applies). A label that could never appear on the bus is an argument
 * error, not an empty match.
 */
function addressLabel(value: string): boolean {
  return validateBusEnvelope({
    id: value, from: value, to: value, priority: 'P3', ttl: 1, body: null,
  }).ok;
}

function invalid(error: string): BusPageQueryResult { return { ok: false, error }; }

/**
 * Validate one raw-page query into the shared filter set. `after` defaults
 * to 0 and `limit` to 50 (1..`BUS_INBOX_MAX_READ`); every filter value is
 * checked by the same rule its CLI flag and MCP argument already apply, so
 * an HTTP read and a CLI read can never disagree about what a filter
 * accepts. Unknown keys are the caller's `allowed` check, not this parser's.
 */
export function parseBusPageQuery(input: BusPageQueryInput): BusPageQueryResult {
  const afterRaw = input.after ?? '0', limitRaw = input.limit ?? '50';
  if (!CURSOR.test(afterRaw) || !CURSOR.test(limitRaw)) return invalid('Invalid cursor or limit.');
  const after = Number(afterRaw), limit = Number(limitRaw);
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > BUS_INBOX_MAX_READ) {
    return invalid('Invalid cursor or limit.');
  }
  const refs: BusPageAddressRefs = {};
  const filters: BusPageFilters = {};
  for (const key of ['to', 'from', 'excludeFrom'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!addressLabel(value)) return invalid(`Invalid ${key} address.`);
    refs[key] = value;
  }
  for (const key of ['id', 'inReplyTo'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!addressLabel(value)) return invalid(`Invalid ${key} id.`);
    filters[key] = value;
  }
  if (input.priority !== undefined) {
    if (!(BUS_PRIORITIES as readonly string[]).includes(input.priority)) return invalid('Invalid priority.');
    filters.priority = input.priority as BusPriority;
  }
  if (input.kind !== undefined) {
    if (!(BUS_PROTOCOL_KINDS as readonly string[]).includes(input.kind)) return invalid('Invalid kind.');
    filters.kind = input.kind as BusProtocolKind;
  }
  if (input.topic !== undefined) {
    if (!isTopicPattern(input.topic)) return invalid('Invalid topic.');
    filters.topic = input.topic;
  }
  for (const key of ['thread', 'job', 'bodyKind'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!BUS_LABEL.test(value)) return invalid(`Invalid ${key}.`);
    filters[key] = value;
  }
  if (input.result !== undefined) {
    if (!(WORK_RESULT_OUTCOMES as readonly string[]).includes(input.result)) return invalid('Invalid result.');
    filters.result = input.result as WorkResultOutcome;
  }
  if (input.channel !== undefined) {
    if (!agentChannelNameSchema.safeParse(input.channel).success) return invalid('Invalid channel.');
    filters.channel = input.channel;
  }
  for (const key of ['since', 'before'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const resolved = parseSince(value);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return invalid(`Invalid ${key}.`);
    filters[key] = resolved;
  }
  if (input.contains !== undefined) {
    const needle = busReadContains(input.contains);
    if (needle === null || needle === undefined) return invalid('Invalid contains.');
    filters.contains = needle;
  }
  return { ok: true, after, limit, refs, filters };
}
