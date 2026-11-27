/**
 * `agents bus dead-letters`: the fleet-level read of the transport dead-letter
 * sink (docs/AGENT-BUS.md "Dead letters"). Every live envelope the router
 * filed under the reserved `bus.dead-letter` address — mail that provably
 * never landed — with its parsed delivery-failure report, in the same claim
 * order `work mine`'s deadLetters section lists them (priority band, then
 * cursor). `work mine` keeps only letters whose ORIGINAL recipient is the
 * agent; this read is the operator surface the unified inbox's
 * `bus-dead-letter` items and `agents bus status`'s deadLetters probe point
 * at — the same bounded `listBusInboxAfter` live-receipt walk, never a
 * second store. Read-only: no claims, no mutations.
 */
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter } from '../fleet/bus-inbox.js';
import { groupAddressTopicOf } from '../fleet/bus-group.js';
import { agentChannelNameSchema, agentRefAddressMatcher, readAgentRegistry, resolveAgent, type AgentRegistry } from './bus-identity.js';
import { busReadContains } from './bus-unified.js';
import { BUS_DEAD_LETTER_ADDRESS, BUS_DEAD_LETTER_REASONS, busDeadLetterContainsText, busDeadLetterReason,
  busDeadLetterReport, busDeadLetterSummary, type BusDeadLetterReason, type BusDeadLetterReport } from './bus-dead-letter.js';
import { BUS_PRIORITIES, type BusPriority } from '../fleet/bus-envelope.js';

/** Letters one page returns at most — the same bound `agents bus inbox --limit` keeps. */
export const BUS_DEAD_LETTERS_LIMIT_MAX = 100;
/** The same bounded walk `work mine`'s pending-work sections run: enough pages
 * to reach the store's own row cap, plus one for the short-page proof. */
const DEAD_LETTERS_MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;

export interface BusDeadLettersOptions {
  /** Fleet root shared by the bus store and the identity registry. */
  root?: string;
  /** Read clock; default Date.now. Frozen once per read like every bus read. */
  now?: () => number;
  /** Keep only letters received at or after this epoch-ms cutoff. */
  since?: number;
  /** Keep only letters received before this epoch-ms cutoff (exclusive). */
  before?: number;
  /** Case-insensitive substring over the report's descriptive facts — the
   * same needle `busReadContains` normalizes every bus `--contains` with. */
  contains?: string;
  /** Keep only letters of this exact P0..P3 band — the letter's own priority. */
  priority?: BusPriority;
  /** Keep only the letter whose own wire id OR whose original envelope id
   * equals the value — the same dual match `work mine --id` applies. */
  id?: string;
  /** Keep only letters whose classified failure reason equals the value —
   * the closed set `agents bus status` tallies. */
  reason?: BusDeadLetterReason;
  /** Keep only letters whose ORIGINAL sender label the ref resolves to —
   * the same `agentRefAddressMatcher` rule every bus `--from` applies. */
  from?: string;
  /** Drop letters whose ORIGINAL sender label the ref resolves to. */
  excludeFrom?: string;
  /** Keep only letters whose ORIGINAL recipient label the ref resolves to. */
  to?: string;
  /** Keep only letters whose ORIGINAL recipient carries `group:<name>:` —
   * the same raw room prefix every bus read's `--channel` matches. */
  channel?: string;
  /** Keep only letters whose ORIGINAL recipient is a well-formed
   * `group:<room>:<topic>` address carrying this exact topic component —
   * the same `groupAddressTopicOf` match every bus read's `--topic`
   * applies, composing with `channel` into one room AND one topic while a
   * report naming an agent address, a bare label or a `group:<room>`
   * without a topic never matches. The value takes the strict
   * channel-name grammar; a report proving no group-address recipient
   * never matches either. */
  topic?: string;
  /** Keep only letters whose ORIGINAL envelope kind equals the value. */
  bodyKind?: string;
  /** Cap the returned `letters`; `matched` still reports the filtered total. */
  limit?: number;
}

export interface BusDeadLetterItem {
  /** Store cursor of the retained letter. */
  cursor: number;
  /** The letter's own wire id — what `agents bus show` resolves. */
  id: string;
  /** The letter envelope's P0..P3 band. */
  priority: BusPriority;
  /** ISO receipt time of the letter. */
  ts: string;
  /** ISO deadline the retained letter stops listing at. */
  expiresAt: string;
  /** Original envelope id the report kept, or null when unprovable. */
  originalId: string | null;
  /** Original recipient routing label, or null when the report cannot prove one. */
  to: string | null;
  /** Original sender routing label, or null when the report cannot prove one. */
  from: string | null;
  /** Handle of the identity `from` resolves to, or null. */
  fromAgent: string | null;
  /** Original envelope kind the report kept, or null. */
  kind: string | null;
  /** The recorded failure reason verbatim, or null. */
  reason: string | null;
  /** The classified failure reason `--reason` filters and status tallies. */
  reasonKind: BusDeadLetterReason;
  /** Delivery attempts the report counted, or null. */
  attempts: number | null;
  /** Whether the router dropped the original payload to fit the letter. */
  payloadDropped: boolean;
  /** The scrubbed one-line report text. */
  summary: string;
}

export type BusDeadLettersResult =
  | { status: 'ok'; source: 'missing' | 'available'; letters: BusDeadLetterItem[];
      matched: number; truncated: boolean; asOf: string }
  | { status: 'invalid' | 'unavailable' | 'retryable'; reason: string };

interface DeadLetterCandidate {
  cursor: number;
  receivedAt: number;
  priority: BusPriority;
  id: string;
  expiresAt: number;
  report: BusDeadLetterReport | null;
  summary: string;
  containsText: string;
}

const invalid = (reason: string): BusDeadLettersResult => ({ status: 'invalid', reason });

/**
 * List the live dead-letter letters, filtered and capped. A verified-missing
 * store reports `source:'missing'` with real zeros; an unreadable one reports
 * `unavailable` — never an empty page pretending health. A scan that cannot
 * reach the store's end reports `retryable`, so `matched` is always the true
 * filtered total, never a partial count.
 */
export function readBusDeadLetters(options: BusDeadLettersOptions = {}): BusDeadLettersResult {
  const nowMs = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return invalid('Clock is unavailable.');
  const asOf = new Date(nowMs).toISOString();
  const contains = busReadContains(options.contains);
  if (contains === null) return invalid('--contains must be non-empty text of at most 512 characters.');
  if (options.since !== undefined && (!Number.isSafeInteger(options.since) || options.since < 0)) {
    return invalid('--since must resolve to a non-negative epoch-ms cutoff.');
  }
  if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 0)) {
    return invalid('--before must resolve to a non-negative epoch-ms cutoff.');
  }
  if (options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > BUS_DEAD_LETTERS_LIMIT_MAX)) {
    return invalid(`--limit must be an integer between 1 and ${BUS_DEAD_LETTERS_LIMIT_MAX}.`);
  }
  if (options.priority !== undefined && !(BUS_PRIORITIES as readonly string[]).includes(options.priority)) {
    return invalid('--priority must be P0, P1, P2 or P3.');
  }
  if (options.reason !== undefined && !(BUS_DEAD_LETTER_REASONS as readonly string[]).includes(options.reason)) {
    return invalid(`--reason must be one of ${BUS_DEAD_LETTER_REASONS.join(', ')}.`);
  }
  // The same strict channel-name grammar every bus read's `--topic`
  // validates; matching itself is the shared `groupAddressTopicOf` parse,
  // so an unknown topic is an honest empty match, never an error and
  // never a widened one.
  if (options.topic !== undefined && !agentChannelNameSchema.safeParse(options.topic).success) {
    return invalid('--topic takes a bus channel topic (a-z, 0-9, _ -; 1-32 chars).');
  }

  const store = inspectBusInbox({ root: options.root, now: () => nowMs });
  if (store.source === 'missing') {
    return { status: 'ok', source: 'missing', letters: [], matched: 0, truncated: false, asOf };
  }
  if (store.source !== 'available') {
    return { status: 'unavailable', reason: 'Bus store is not readable.' };
  }

  // Sender/recipient refs resolve through the registry exactly like every
  // bus `--from`/`--to` read; an unreadable registry keeps literal-label
  // matching, never a widened one.
  const read = readAgentRegistry({ root: options.root });
  const registry: AgentRegistry | undefined = read.status === 'ok' ? read.registry : undefined;
  const fromMatch = options.from === undefined ? undefined : agentRefAddressMatcher(options.from, registry);
  const excludeFromMatch = options.excludeFrom === undefined ? undefined : agentRefAddressMatcher(options.excludeFrom, registry);
  const toMatch = options.to === undefined ? undefined : agentRefAddressMatcher(options.to, registry);
  const channelPrefix = options.channel === undefined ? undefined : `group:${options.channel}:`;
  const sender = (from: string | null): string | null =>
    from === null || registry === undefined ? null : resolveAgent(registry, from)?.handle ?? null;

  const candidates: DeadLetterCandidate[] = [];
  let cursor = 0, finished = false;
  for (let index = 0; index < DEAD_LETTERS_MAX_PAGES && !finished; index += 1) {
    const page = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: options.root, now: () => nowMs });
    if (page.status !== 'ok') {
      return { status: page.status === 'retryable' ? 'retryable' : page.status === 'invalid' ? 'invalid' : 'unavailable',
        reason: 'Bus store is not readable.' };
    }
    for (const row of page.messages) {
      const envelope = row.envelope;
      if (envelope.to !== BUS_DEAD_LETTER_ADDRESS) continue;
      const report = busDeadLetterReport(envelope.body);
      candidates.push({
        cursor: row.cursor, receivedAt: row.receivedAt, priority: envelope.priority,
        id: envelope.id,
        // The reader decrements ttl to what remains; expiry is a real deadline.
        expiresAt: nowMs + envelope.ttl,
        report,
        summary: busDeadLetterSummary(report),
        containsText: busDeadLetterContainsText(report).toLowerCase().replace(/\s+/g, ' '),
      });
    }
    if (page.messages.length < BUS_INBOX_MAX_READ) { finished = true; break; }
    if (page.nextCursor <= cursor) {
      return { status: 'retryable', reason: 'Bus store cursor did not advance.' };
    }
    cursor = page.nextCursor;
  }
  if (!finished) {
    return { status: 'retryable', reason: 'Bus store scan exceeded the bounded read.' };
  }

  const filtered = candidates.filter(candidate => {
    const report = candidate.report;
    if (contains !== undefined && !candidate.containsText.includes(contains)) return false;
    if (options.since !== undefined && candidate.receivedAt < options.since) return false;
    if (options.before !== undefined && candidate.receivedAt >= options.before) return false;
    if (options.priority !== undefined && candidate.priority !== options.priority) return false;
    if (options.id !== undefined && candidate.id !== options.id && report?.id !== options.id) return false;
    if (options.reason !== undefined && busDeadLetterReason(report) !== options.reason) return false;
    if (options.bodyKind !== undefined && report?.kind !== options.bodyKind) return false;
    if (channelPrefix !== undefined && (report?.to === null || report?.to === undefined ||
        !report.to.startsWith(channelPrefix))) return false;
    if (options.topic !== undefined && (report?.to === null || report?.to === undefined ||
        groupAddressTopicOf(report.to) !== options.topic)) return false;
    if (fromMatch !== undefined && (report?.from === null || report?.from === undefined || !fromMatch(report.from))) return false;
    if (excludeFromMatch !== undefined && (report?.from === null || report?.from === undefined || excludeFromMatch(report.from))) return false;
    if (toMatch !== undefined && (report?.to === null || report?.to === undefined || !toMatch(report.to))) return false;
    return true;
  });
  // The same claim order `work mine`'s deadLetters section lists: priority
  // band first, then store cursor — urgent letters surface ahead of routine.
  filtered.sort((a, b) => BUS_PRIORITIES.indexOf(a.priority) - BUS_PRIORITIES.indexOf(b.priority) || a.cursor - b.cursor);

  const limit = options.limit ?? BUS_DEAD_LETTERS_LIMIT_MAX;
  const letters = filtered.slice(0, limit).map(candidate => ({
    cursor: candidate.cursor, id: candidate.id, priority: candidate.priority,
    ts: new Date(candidate.receivedAt).toISOString(), expiresAt: new Date(candidate.expiresAt).toISOString(),
    originalId: candidate.report?.id ?? null, to: candidate.report?.to ?? null,
    from: candidate.report?.from ?? null, fromAgent: sender(candidate.report?.from ?? null),
    kind: candidate.report?.kind ?? null, reason: candidate.report?.reason ?? null,
    reasonKind: busDeadLetterReason(candidate.report),
    attempts: candidate.report?.attempts ?? null, payloadDropped: candidate.report?.payloadDropped ?? false,
    summary: candidate.summary,
  }));
  return { status: 'ok', source: 'available', letters, matched: filtered.length,
    truncated: filtered.length > letters.length, asOf };
}
