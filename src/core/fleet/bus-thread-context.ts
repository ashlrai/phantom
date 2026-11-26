import { isProxy } from 'node:util/types';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { BUS_PRIORITIES, type BusPriority } from './bus-envelope.js';
import { annotateLiveEvidence, busBodyInReplyToMatch, busBodyJobMatch, busReadContains, busReadContainsMatch,
  type BusEnvelopeLookupJob } from '../agents/bus-unified.js';
import { agentChannelNameSchema, agentPendingAddressMatcher, agentRefAddressMatcher, readAgentRegistry, resolveAgent } from '../agents/bus-identity.js';
import { busBodyKind, busBodyResultOutcome, busBodyThread, WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../agents/bus-v2-schema.js';

/** Select data correlations only; routing labels and message bodies confer no authority. */
export function projectBusThread(rows: readonly BusInboxReceipt[], id: string): BusInboxReceipt[] {
  if (!rows.some(row => row.envelope.id === id)) return [];
  const children = new Map<string, BusInboxReceipt[]>();
  for (const row of rows) {
    const body = row.envelope.body;
    if (!body || typeof body !== 'object' || isProxy(body) || Array.isArray(body)) continue;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) continue;
    const property = Object.getOwnPropertyDescriptor(body, 'inReplyTo');
    if (!property?.enumerable || !('value' in property) || typeof property.value !== 'string') continue;
    const list = children.get(property.value) ?? [];
    list.push(row);
    children.set(property.value, list);
  }
  const selected = new Set([id]), pending = [id];
  for (let i = 0; i < pending.length; i++) {
    for (const row of children.get(pending[i]!) ?? []) {
      if (!selected.has(row.envelope.id)) {
        selected.add(row.envelope.id);
        pending.push(row.envelope.id);
      }
    }
  }
  const emitted = new Set<string>();
  return [...rows].sort((a, b) => a.cursor - b.cursor).filter(row => {
    const key = row.envelope.id;
    if (!selected.has(key) || emitted.has(key)) return false;
    emitted.add(key);
    return true;
  });
}

/**
 * One retained thread receipt plus, when the read asked for live evidence,
 * the same per-message annotations `agents bus inbox`, `agents bus channel
 * read` and `agents bus show` report: `held`/`holder` on claimable work and
 * worker-handoff bodies — whether a taken message-id claim or a live
 * coordination hold provably covers the exact receipt, `held` false proof of
 * free and null a hold store that could not be read — `job` on bodies that
 * name a job (the live feed state of the cited job, or the feed's own
 * refusal/unavailable state), and `fromAgent`, the registered handle of the
 * sender label or null — a label is never authentication. Every field stays
 * absent on a raw read and on a body kind the annotation does not cover —
 * never guessed.
 */
export interface BusThreadMessage extends BusInboxReceipt {
  held?: boolean | null;
  holder?: string | null;
  job?: BusEnvelopeLookupJob;
  fromAgent?: string | null;
}

/** Printable ASCII routing labels, the same constraint the wire token fields and every bus read filter share. */
const label = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,128}(?![\s\S])/.test(value);

/**
 * The read filters the reply-chain read shares with every other bus read —
 * the `fleet bus-follow`/`fleet_bus_inbox`/`agents bus inbox` family minus
 * the filters that name the read itself (`id` roots the chain here) or a
 * delivery axis the chain does not carry (`kind`, `topic`). Every field is
 * optional and conjunctive: a chain member must satisfy all of them to stay
 * in `messages`. The filters narrow the projected members only — they never
 * change which envelopes the `inReplyTo` walk selects, so `rootFound`,
 * `scannedThrough`, `complete` and `sourceFailure` keep describing the
 * unfiltered chain exactly as an unfiltered read reports them, and a root
 * that exists but whose every member a filter excludes still reports
 * `rootFound: true` with an empty `messages` — a proven miss only ever
 * means the root itself is absent.
 *
 * `to`/`from`/`excludeFrom` are routing refs resolved once against the
 * server-side registry under the same exact-label fallback every bus read
 * applies — `to` keeps the addressed-to rule (`agentPendingAddressMatcher`,
 * channel posts the sender identity wrote itself excluded), `from` keeps
 * the sender-inclusion rule and `excludeFrom` the sender-exclusion rule
 * (`agentRefAddressMatcher`); an unreadable registry or unresolvable ref
 * keeps exact-label matching, never widening. `channel` keeps members
 * addressed to `group:<channel>:*`; `job` the `busBodyJobMatch` citation
 * rule; `priority` the exact P0..P3 band; `thread` the `busBodyThread`
 * label on note/context bodies; `inReplyTo` the own-property
 * `busBodyInReplyToMatch` citation; `bodyKind` the `busBodyKind`
 * discriminator; `result` the `busBodyResultOutcome` outcome;
 * `since`/`before` the `[since, before)` receivedAt window (`since`
 * inclusive, `before` exclusive); `contains` the bounded
 * `busReadContainsMatch` needle over the scrubbed one-line summary, never
 * the raw body. Filtering is not authentication.
 */
export interface BusThreadFilters {
  to?: string;
  from?: string;
  excludeFrom?: string;
  channel?: string;
  job?: string;
  priority?: BusPriority;
  thread?: string;
  since?: number;
  before?: number;
  contains?: string;
  inReplyTo?: string;
  bodyKind?: string;
  result?: WorkResultOutcome;
}

/**
 * The `validBusFollowRequest` rule applied to the thread filter set: every
 * label-shaped field takes the printable routing-label grammar, `channel`
 * the strict channel-name schema, `priority`/`result` their enums,
 * `since`/`before` safe non-negative epoch-ms integers and `contains` the
 * shared `busReadContains` bound. Callers run this before `readBusThread` —
 * an invalid filter is a usage error on the CLI surfaces and a refused
 * argument on the MCP tool, never a silently ignored or widened read.
 */
export function validBusThreadFilters(filters: BusThreadFilters | undefined): boolean {
  if (filters === undefined) return true;
  return (filters.to === undefined || label(filters.to)) &&
    (filters.from === undefined || label(filters.from)) &&
    (filters.excludeFrom === undefined || label(filters.excludeFrom)) &&
    (filters.channel === undefined || agentChannelNameSchema.safeParse(filters.channel).success) &&
    (filters.job === undefined || label(filters.job)) &&
    (filters.priority === undefined || BUS_PRIORITIES.includes(filters.priority)) &&
    (filters.thread === undefined || label(filters.thread)) &&
    (filters.since === undefined || (Number.isSafeInteger(filters.since) && filters.since >= 0)) &&
    (filters.before === undefined || (Number.isSafeInteger(filters.before) && filters.before >= 0)) &&
    busReadContains(filters.contains) !== null &&
    (filters.inReplyTo === undefined || label(filters.inReplyTo)) &&
    (filters.bodyKind === undefined || label(filters.bodyKind)) &&
    (filters.result === undefined || (WORK_RESULT_OUTCOMES as readonly string[]).includes(filters.result));
}

export interface BusThreadOptions extends BusInboxOptions {
  /**
   * Annotate each thread message with the live evidence `agents bus inbox`,
   * `agents bus channel read` and `agents bus show` report — `held`/`holder`
   * on claimable work and worker-handoff bodies, `job` on job-citing bodies,
   * `fromAgent` on every row — through the same shared annotation those
   * reads apply, so a thread answers "is this work already claimed" and
   * "where does the cited job stand" without a `show` per message. Off by
   * default: callers that only need the retained envelopes (the worker-run
   * prompt section) never pay for the hold-store, feed and registry reads
   * the evidence costs. Read-only either way — the annotation reads the
   * same stores the unified reads do and writes nothing.
   */
  liveEvidence?: boolean;
  /**
   * The shared bus-read filters applied to the projected chain members —
   * see `BusThreadFilters`. The walk, TTL recheck and `inReplyTo`
   * selection are unaffected: filters only decide which already-selected
   * members `messages` carries, so `rootFound` still reports whether the
   * root itself is live. Callers validate with `validBusThreadFilters`
   * first; the read applies the fields as given.
   */
  filters?: BusThreadFilters;
}

export interface BusThreadResult {
  schema: 'fleet.bus-thread.v1';
  requestedId: string;
  rootFound: boolean;
  messages: BusThreadMessage[];
  scannedThrough: number;
  complete: boolean;
  sourceFailure: string | null;
}

/**
 * The sender-handle decoration `bus show`, `agents bus inbox` and
 * `channel read` apply to every row: the registered handle of the
 * envelope's `from` label, or null — an unreadable registry or an
 * unresolvable label stays null, never a guessed name.
 */
function annotateThreadSenders(messages: BusThreadMessage[], options: BusInboxOptions): void {
  const read = readAgentRegistry(options);
  const registry = read.status === 'ok' ? read.registry : undefined;
  for (const message of messages) {
    message.fromAgent = registry === undefined ? null
      : resolveAgent(registry, message.envelope.from)?.handle ?? null;
  }
}

/**
 * The per-member predicate `filters` describes — the same matcher set
 * `followBusStream` builds once per read: the addressed-to, channel,
 * sender-include/exclude, job, reply-citation, priority, body-kind,
 * work-result, thread-label, receivedAt-window and contains rules every
 * bus read shares, resolved against one registry read so a thread can
 * never disagree with the inbox or follow about what a ref or needle
 * names. Returns undefined when no filter is set.
 */
function busThreadRowFilter(filters: BusThreadFilters, options: BusInboxOptions): ((row: BusInboxReceipt) => boolean) | undefined {
  if (Object.values(filters).every(value => value === undefined)) return undefined;
  const registryRead = filters.to === undefined && filters.from === undefined && filters.excludeFrom === undefined
    ? undefined : readAgentRegistry(options);
  const registry = registryRead?.status === 'ok' ? registryRead.registry : undefined;
  const addressedTo = filters.to === undefined ? undefined : agentPendingAddressMatcher(filters.to, registry);
  const channelPrefix = filters.channel === undefined ? undefined : `group:${filters.channel}:`;
  const fromMatch = filters.from === undefined ? undefined : agentRefAddressMatcher(filters.from, registry);
  const excludeFromMatch = filters.excludeFrom === undefined ? undefined : agentRefAddressMatcher(filters.excludeFrom, registry);
  // The caller ran validBusThreadFilters, so the needle is normalized text or absent.
  const containsNeedle = busReadContains(filters.contains) ?? undefined;
  return row => {
    const envelope = row.envelope;
    if (addressedTo !== undefined && !addressedTo(envelope.to, envelope.from)) return false;
    if (channelPrefix !== undefined && !envelope.to.startsWith(channelPrefix)) return false;
    if (filters.inReplyTo !== undefined && !busBodyInReplyToMatch(envelope.body, filters.inReplyTo)) return false;
    if (filters.job !== undefined && !busBodyJobMatch(envelope.body, filters.job)) return false;
    if (fromMatch !== undefined && !fromMatch(envelope.from)) return false;
    if (excludeFromMatch !== undefined && excludeFromMatch(envelope.from)) return false;
    if (filters.priority !== undefined && envelope.priority !== filters.priority) return false;
    if (filters.bodyKind !== undefined && busBodyKind(envelope.body) !== filters.bodyKind) return false;
    if (filters.result !== undefined && busBodyResultOutcome(envelope.body) !== filters.result) return false;
    if (filters.thread !== undefined && busBodyThread(envelope.body) !== filters.thread) return false;
    if (filters.since !== undefined && row.receivedAt < filters.since) return false;
    if (filters.before !== undefined && row.receivedAt >= filters.before) return false;
    if (containsNeedle !== undefined && !busReadContainsMatch(envelope.body, containsNeedle)) return false;
    return true;
  };
}

/** Read bounded live pages and recheck TTL before projection. Pages are not an atomic snapshot. */
export function readBusThread(id: string, options: BusThreadOptions = {}, list = listBusInboxAfter): BusThreadResult {
  const { liveEvidence = false, filters, ...busOptions } = options;
  const rows: BusInboxReceipt[] = [];
  let cursor = 0, complete = false, failure: string | null = null;
  let now = 0, clockValid = false;
  try {
    now = (busOptions.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('clock');
    clockValid = true;
    while (cursor < BUS_INBOX_MAX_MESSAGES) {
      const page = list(cursor, BUS_INBOX_MAX_READ, { ...busOptions, now: () => now });
      if (page.status !== 'ok') { failure = page.status; break; }
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || page.nextCursor > BUS_INBOX_MAX_MESSAGES ||
        page.messages.length > BUS_INBOX_MAX_READ || page.messages.some((row, i) =>
          !Number.isSafeInteger(row.cursor) || row.cursor <= (i ? page.messages[i - 1]!.cursor : cursor) || row.cursor > page.nextCursor)) {
        failure = 'invalid-page'; break;
      }
      if (page.nextCursor === cursor && page.messages.length !== 0) { failure = 'invalid-page'; break; }
      rows.push(...page.messages);
      const advanced = page.nextCursor > cursor;
      cursor = page.nextCursor;
      if (page.messages.length < BUS_INBOX_MAX_READ || cursor === BUS_INBOX_MAX_MESSAGES) { complete = true; break; }
      if (!advanced) { failure = 'invalid-page'; break; }
    }
  } catch { failure = 'unavailable'; }
  let live: BusInboxReceipt[] = [];
  try {
    if (!clockValid) throw new Error('clock');
    const finishedAt = (busOptions.now ?? Date.now)();
    if (!Number.isSafeInteger(finishedAt) || finishedAt < 0) throw new Error('clock');
    const elapsed = Math.max(0, finishedAt - now);
    live = rows.filter(row => row.envelope.ttl > elapsed).map(row => ({
      ...row, envelope: { ...row.envelope, ttl: row.envelope.ttl - elapsed },
    }));
  } catch { complete = false; failure = 'clock'; }
  const projected = projectBusThread(live, id);
  // rootFound reports the unfiltered chain: a live root whose every member a
  // read filter excludes is still a found thread — an empty `messages` under
  // filters is an honest no-match, never a proven miss.
  const rootFound = projected.length > 0;
  const match = filters === undefined ? undefined : busThreadRowFilter(filters, busOptions);
  const messages: BusThreadMessage[] = match === undefined ? projected : projected.filter(match);
  // The evidence reads run against the same frozen instant the TTL recheck
  // used, so lease liveness and feed state describe the read's own snapshot.
  if (liveEvidence && messages.length > 0) {
    annotateLiveEvidence(messages, { ...busOptions, now: () => now });
    annotateThreadSenders(messages, busOptions);
  }
  return { schema: 'fleet.bus-thread.v1', requestedId: id, rootFound,
    messages, scannedThrough: cursor, complete, sourceFailure: failure };
}
