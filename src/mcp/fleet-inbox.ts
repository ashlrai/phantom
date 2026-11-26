/**
 * Durable bus-inbox observation for the isolated fleet MCP server. Reuses the
 * canonical store behind `phm comms bus` — never a second bus — and stays
 * read-only: no TTL renewal, no store creation, no dispatch. Routing labels
 * are data, never authenticated identity; bodies are untrusted.
 */
import {
  BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter,
} from '../core/fleet/bus-inbox.js';
import { BUS_PRIORITIES, validateBusEnvelope, type BusPriority, type BusProtocolKind } from '../core/fleet/bus-envelope.js';
import { BUS_PROTOCOL_KINDS, isTopicPattern, protocolOf, topicMatches } from '../core/fleet/bus-protocol.js';
import { agentChannelNameSchema, agentRefAddressMatcher, readAgentRegistry } from '../core/agents/bus-identity.js';
import { busBodyKind, busBodyResultOutcome, busBodyThread, WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../core/agents/bus-v2-schema.js';
import { busBodyInReplyToMatch, busBodyJobMatch, busReadContains, busReadContainsMatch } from '../core/agents/bus-unified.js';
import { parseSince } from '../core/fleet/agent-messages.js';

export const MAX_FLEET_BUS_INBOX_READ = BUS_INBOX_MAX_READ;
export const DEFAULT_FLEET_BUS_INBOX_READ = 50;

/**
 * The `phm comms bus read` filter set resolved for one page — every field
 * narrows the scanned page, none fabricates: the same predicates the CLI's
 * `filterPage` applies, so an MCP read and a CLI read can never disagree
 * about what a filter keeps.
 */
export interface FleetBusInboxFilters {
  /** Exact envelope id. */
  id?: string;
  /** Exact `inReplyTo` field on object bodies. */
  inReplyTo?: string;
  /** Sender routing label excluded under every label of one registered identity. */
  excludeFrom?: string;
  /** Exact P0..P3 priority band. */
  priority?: BusPriority;
  /** Protocol-v1 body kind (task, result, review, status, question). */
  kind?: BusProtocolKind;
  /** Topic name or namespace prefix the body's protocol topic must match. */
  topic?: string;
  /** v2 thread label — matches `note`/`context` bodies only. */
  thread?: string;
  /** Room filter: keeps only envelopes addressed to `group:<channel>:*` —
   * the same raw `to`-prefix rule `phm comms bus read --channel`,
   * `fleet bus-follow --channel`, `phm messages --channel`,
   * `agents bus wakes --channel` and the work feed's `--channel` apply; the
   * strict channel-name grammar, decided on the `to` label with no registry
   * dependence — the addressed `agents bus inbox --channel` resolves the
   * same prefix only across channels the agent belongs to. */
  channel?: string;
  /** One job id the body must name (the shared `busBodyJobMatch` rule). */
  job?: string;
  /** Exact body-kind discriminator the body must carry (the shared
   * `busBodyKind` own-field match): the v2 `kind` field, else a
   * bus-transport v1 `protocol.kind`, else the `type`/`schema` a kindless
   * notice keys on — matched exactly and case-sensitively, so a body
   * carrying no discriminator never matches and an unrecognized but
   * printable value is an honest empty page, never an error and never a
   * widened one. */
  bodyKind?: string;
  /** `work.result` outcome code the `busBodyResultOutcome` own-field match
   * reads — the same `WORK_RESULT_OUTCOMES` vocabulary every bus read's
   * result filter validates. */
  result?: WorkResultOutcome;
  /** Epoch-ms cutoff resolved at parse time; keeps `receivedAt >= since`. */
  since?: number;
  /** Epoch-ms cutoff resolved at parse time; keeps `receivedAt < before` —
   * the exclusive upper bound composing with `since` into one
   * `[since, before)` window, the same rule `phm comms bus read|watch
   * --before` and `fleet bus-follow --before` apply. */
  before?: number;
  /** Normalized `--contains` needle over the scrubbed one-line summary. */
  contains?: string;
}

export interface FleetBusInboxArgs {
  /** Durable integer cursor; receipts with cursor <= after are skipped. */
  after: number;
  /** Cap on scanned live records, applied before every filter. */
  limit: number;
  /** Recipient routing label; matches any label of the same registered agent identity. */
  to?: string;
  /** Sender routing label; matches any label of the same registered agent identity. */
  from?: string;
  /** Optional read filters — the same dimensions `phm comms bus read` applies. */
  filters?: FleetBusInboxFilters;
}

export interface FleetBusInboxDeps {
  inspect?: typeof inspectBusInbox;
  list?: typeof listBusInboxAfter;
}

const INBOX_KEYS = new Set(['after', 'limit', 'to', 'from',
  'id', 'inReplyTo', 'excludeFrom', 'priority', 'kind', 'topic', 'bodyKind', 'result', 'thread', 'job', 'channel', 'since', 'before', 'contains']);
/** The printable-label rule `--thread`, `--job` and the address fields share. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

/**
 * Routing labels use the bus wire contract: printable ASCII tokens of 1..128
 * characters (the same dummy-envelope check `phm comms bus read` applies). A
 * label that could never appear on the bus is an argument error, not an
 * empty match.
 */
function addressLabel(value: unknown): value is string {
  return typeof value === 'string' && validateBusEnvelope({
    id: value, from: value, to: value, priority: 'P3', ttl: 1, body: null,
  }).ok;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys,
 * non-integer cursors, out-of-range limits, malformed labels and malformed
 * filter values are rejected before the store is touched — the same checks
 * `phm comms bus read` runs on its flags.
 */
export function parseFleetBusInboxArgs(args: Record<string, unknown>): FleetBusInboxArgs | null {
  const after = args['after'] ?? 0, limit = args['limit'] ?? DEFAULT_FLEET_BUS_INBOX_READ;
  const to = args['to'], from = args['from'];
  if (Object.keys(args).some(key => !INBOX_KEYS.has(key)) ||
    args['after'] === null || args['limit'] === null ||
    typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_BUS_INBOX_READ ||
    to !== undefined && !addressLabel(to) || from !== undefined && !addressLabel(from)) return null;

  const filters: FleetBusInboxFilters = {};
  for (const key of ['id', 'inReplyTo', 'excludeFrom'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (!addressLabel(value)) return null;
    filters[key] = value;
  }
  const priority = args['priority'];
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    filters.priority = priority as BusPriority;
  }
  const kind = args['kind'];
  if (kind !== undefined) {
    if (typeof kind !== 'string' || !(BUS_PROTOCOL_KINDS as readonly string[]).includes(kind)) return null;
    filters.kind = kind as BusProtocolKind;
  }
  const topic = args['topic'];
  if (topic !== undefined) {
    if (!isTopicPattern(topic)) return null;
    filters.topic = topic;
  }
  for (const key of ['thread', 'job', 'bodyKind'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !BUS_LABEL.test(value)) return null;
    filters[key] = value;
  }
  const result = args['result'];
  if (result !== undefined) {
    if (typeof result !== 'string' || !(WORK_RESULT_OUTCOMES as readonly string[]).includes(result)) return null;
    filters.result = result as WorkResultOutcome;
  }
  const channel = args['channel'];
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
    filters.channel = channel;
  }
  const since = args['since'];
  if (since !== undefined) {
    if (typeof since !== 'string') return null;
    const resolved = parseSince(since);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    filters.since = resolved;
  }
  const before = args['before'];
  if (before !== undefined) {
    if (typeof before !== 'string') return null;
    const resolved = parseSince(before);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    filters.before = resolved;
  }
  const contains = busReadContains(args['contains']);
  if (contains === null) return null;
  if (contains !== undefined) filters.contains = contains;

  return { after, limit, to: to as string | undefined, from: from as string | undefined,
    ...(Object.keys(filters).length === 0 ? {} : { filters }) };
}

/**
 * One durable page after `after`, filtered by routing labels resolved through
 * the agent identity registry beside the bus store: a `to`/`from`/`excludeFrom`
 * naming any label of a registered identity matches every label of that
 * identity, the same read `phm comms bus read|watch` and `bus next` use; an
 * unresolvable label or an unreadable registry keeps exact-label matching, so
 * unknown identity state never widens a page. The limit counts scanned live
 * records before filtering (the CLI's contract), so an unmatched page still
 * advances nextCursor without replay; expired records advance it unseen and
 * never count. `sourceState` stays honest: missing, unavailable and retryable
 * stores surface as themselves, never as an invented successful empty page.
 * Envelope ttl is the remaining lifetime measured from the original receipt —
 * reading never renews it.
 */
export async function readFleetBusInbox(input: FleetBusInboxArgs, deps: FleetBusInboxDeps = {}) {
  const inspect = deps.inspect ?? inspectBusInbox, list = deps.list ?? listBusInboxAfter;
  const inspection = inspect();
  const filters = input.filters;
  const base = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
    retainedCount: inspection.retainedCount,
    liveCount: inspection.liveCount,
    expiredCount: inspection.expiredCount,
    after: input.after, limit: input.limit,
    to: input.to ?? null, from: input.from ?? null,
    filters: filters ?? null,
  };
  if (inspection.source !== 'available') {
    return { ...base, sourceState: inspection.source, messages: null, returnedMessages: null, nextCursor: null };
  }
  const page = list(input.after, input.limit);
  if (page.status !== 'ok') {
    return { ...base, sourceState: page.status, messages: null, returnedMessages: null, nextCursor: null };
  }
  const registryRead = input.to === undefined && input.from === undefined && filters?.excludeFrom === undefined
    ? undefined : readAgentRegistry();
  const registry = registryRead?.status === 'ok' ? registryRead.registry : undefined;
  const to = input.to === undefined ? undefined : agentRefAddressMatcher(input.to, registry);
  const from = input.from === undefined ? undefined : agentRefAddressMatcher(input.from, registry);
  const excludeFrom = filters?.excludeFrom === undefined ? undefined : agentRefAddressMatcher(filters.excludeFrom, registry);
  const messages = page.messages.filter(({ envelope, receivedAt }) =>
    (to === undefined || to(envelope.to)) &&
    (from === undefined || from(envelope.from)) &&
    (excludeFrom === undefined || !excludeFrom(envelope.from)) &&
    (filters?.id === undefined || envelope.id === filters.id) &&
    (filters?.inReplyTo === undefined || busBodyInReplyToMatch(envelope.body, filters.inReplyTo)) &&
    (filters?.priority === undefined || envelope.priority === filters.priority) &&
    (filters?.kind === undefined || protocolOf(envelope.body)?.kind === filters.kind) &&
    (filters?.topic === undefined || topicMatches(filters.topic, protocolOf(envelope.body)?.topic ?? '')) &&
    (filters?.thread === undefined || busBodyThread(envelope.body) === filters.thread) &&
    (filters?.job === undefined || busBodyJobMatch(envelope.body, filters.job)) &&
    (filters?.bodyKind === undefined || busBodyKind(envelope.body) === filters.bodyKind) &&
    (filters?.result === undefined || busBodyResultOutcome(envelope.body) === filters.result) &&
    (filters?.channel === undefined || envelope.to.startsWith(`group:${filters.channel}:`)) &&
    (filters?.since === undefined || receivedAt >= filters.since) &&
    (filters?.before === undefined || receivedAt < filters.before) &&
    (filters?.contains === undefined || busReadContainsMatch(envelope.body, filters.contains)));
  return {
    ...base, sourceState: 'ok' as const, messages,
    returnedMessages: messages.length, nextCursor: page.nextCursor,
  };
}
