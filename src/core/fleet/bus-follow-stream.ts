/** Bounded resumable local observation only. Bodies are untrusted data, never dispatched. */
import { performance } from 'node:perf_hooks';
import { isAbsolute } from 'node:path';
import { BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxPage } from './bus-inbox.js';
import { BUS_PRIORITIES, BUS_PROTOCOL_KINDS, isTopicPattern, protocolOf, topicMatches,
  type BusEnvelope, type BusPriority, type BusProtocolKind } from './bus-envelope.js';
import { agentChannelNameSchema, agentPendingAddressMatcher, agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';
import { busBodyInReplyToMatch, busBodyJobMatch, busReadContains, busReadContainsMatch } from '../agents/bus-unified.js';
import { busBodyKind, busBodyThread } from '../agents/bus-v2-schema.js';

export const BUS_FOLLOW_MAX_DURATION_MS = 3_600_000;
export const BUS_FOLLOW_MIN_INTERVAL_MS = 100;
export const BUS_FOLLOW_MAX_INTERVAL_MS = 60_000;
export const BUS_FOLLOW_DEFAULT_INTERVAL_MS = 250;

/** Printable ASCII routing labels, same constraint as the wire token fields. */
const label = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,128}(?![\s\S])/.test(value);

export interface BusFollowRequest {
  /** Nonnegative safe cursor to resume after; 0 follows from the first retained row. */
  after: number;
  /** Bounded lifetime is mandatory: 1..3600000 milliseconds. */
  durationMs: number;
  /** Optional routing-label filter, resolved once at stream start through the
   * agent identity registry: every label of one registered identity — handle,
   * `agent:` address, stable id or alias — plus the `group:<channel>:<topic>`
   * addresses of channels the identity belongs to, minus the identity's own
   * channel posts. This is the shared "addressed to this agent" rule `bus
   * next` claims by, `work mine` lists and the agent inbox shows, so the
   * stream sees the same pending set those reads report. A `--to` naming no
   * registered identity, membership in no channel, and an unreadable registry
   * keep exact-label matching, so unknown identity state never widens the
   * stream. Filtering is not authentication. */
  to?: string;
  /** Optional channel filter: keeps only envelopes addressed to
   * `group:<channel>:*` — the room's whole traffic under every topic, the
   * same raw `to`-prefix rule `phm messages --channel`, `agents bus wakes
   * --channel`, `channel read` and the work feed's `--channel` apply, so
   * one room's stream is a single flag instead
   * of one `--to group:<channel>:<topic>` per topic. The value is the strict
   * channel-name grammar; matching is a raw prefix on the routing label, so
   * it needs no registry and never widens on unknown state — the addressed
   * `agents bus inbox --channel` resolves the same prefix only across
   * channels the agent belongs to. Checkpoints
   * still advance past filtered rows exactly like every other filter. */
  channel?: string;
  /** Optional job filter: the same `busBodyJobMatch` citation rule
   * `agents bus inbox --job` applies — a `work.post`/`work.status`/
   * `work.result`/`wake` body declaring the `jobId`, a `worker-handoff`
   * assigning that fleet job id through `taskId`, or a `note`/`context`
   * body carrying the `job:<id>` thread label. Every other body kind cites
   * no job and never matches; checkpoints still advance past filtered rows
   * exactly like `--to`, so a job-scoped stream resumes on the same cursor. */
  job?: string;
  /** Optional sender filter: the same `agentRefAddressMatcher` rule
   * `agents bus inbox --from` and `comms bus read --from` apply — a handle,
   * `agent:` address, stable id or alias resolves through the registry to
   * every label of that identity; a sender resolving to no identity and an
   * unreadable registry keep exact-label matching, so unknown identity state
   * never widens the stream. Filtering is not authentication. */
  from?: string;
  /** Optional sender-exclusion filter: the same `agentRefAddressMatcher` rule
   * `comms bus read|watch --exclude-from` and `fleet_bus_inbox`'s `excludeFrom`
   * apply — a handle, `agent:` address, stable id or alias resolves through
   * the registry to every label of that identity; a sender resolving to no
   * identity and an unreadable registry keep exact-label matching, so unknown
   * identity state never widens the stream. Every envelope whose `from` label
   * matches is skipped while checkpoints still advance past it exactly like
   * every other filter. Filtering is not authentication. */
  excludeFrom?: string;
  /** Optional priority filter: exact `BUS_PRIORITIES` match on
   * `envelope.priority`, the same field `agents bus inbox --priority` and
   * `channel read --priority` narrow on. */
  priority?: BusPriority;
  /** Optional thread filter: `busBodyThread` on `note`/`context` bodies —
   * the same field `agents bus inbox --thread` and `channel read --thread`
   * match; bodies carrying no thread never match. */
  thread?: string;
  /** Optional received-at floor in epoch ms: rows received before the cutoff
   * never emit, the same inclusive `receivedAt >= since` match
   * `agents bus inbox --since` resolves its grammar to once per read. */
  since?: number;
  /** Optional received-at ceiling in epoch ms: rows received at or after the
   * cutoff never emit — the exclusive `receivedAt < before` match
   * `comms bus read|watch --before` and `fleet_bus_inbox`'s `before` apply,
   * composing with `since` into one `[since, before)` window where a row
   * stamped exactly at either bound never matches. */
  before?: number;
  /** Optional text filter: the same `busReadContainsMatch` rule
   * `agents bus inbox --contains`, `channel read --contains`,
   * `comms bus read|watch --contains` and `phm messages --contains`
   * apply — a case-insensitive substring over the envelope's scrubbed
   * one-line summary, never the raw body, so a secret-shaped value stays
   * unfindable and protocol-v1 payloads stay opaque to it. Bounded free
   * text, validated by `busReadContains`; checkpoints still advance past
   * filtered rows exactly like every other filter. */
  contains?: string;
  /** Optional exact envelope-id filter: only the receipt carrying this id
   * emits — the same exact, case-sensitive match `comms bus
   * read|watch --id` and `fleet_bus_inbox`'s `id` apply. Ids are transport
   * data, never authenticated identity; checkpoints still advance past
   * filtered rows exactly like every other filter. */
  id?: string;
  /** Optional reply-correlation filter: only envelopes whose object body
   * carries `inReplyTo` equal to this id emit — the shared
   * `busBodyInReplyToMatch` own-property, case-sensitive match `comms bus
   * read|watch --in-reply-to`, `fleet_bus_inbox`'s `inReplyTo`, `phm
   * messages --in-reply-to`, `agents bus inbox --in-reply-to` and
   * `channel read --in-reply-to` apply. An application convention, not
   * an envelope field or authenticated identity; checkpoints still advance
   * past filtered rows exactly like every other filter. */
  inReplyTo?: string;
  /** Optional protocol-v1 body-kind filter: only envelopes whose body
   * carries `protocol.kind` equal to this kind emit — the same
   * `protocolOf(body)?.kind` match `comms bus read|watch --kind` and
   * `fleet_bus_inbox`'s `kind` apply. Bodies without a `protocol` object
   * never match; checkpoints still advance past filtered rows exactly like
   * every other filter. */
  kind?: BusProtocolKind;
  /** Optional protocol-v1 topic filter: only envelopes whose body carries
   * `protocol.topic` matching this name or namespace prefix emit — the same
   * `topicMatches` rule `comms bus read|watch --topic` and `fleet_bus_inbox`'s
   * `topic` apply, so `fleet.*` matches `fleet.deploy` but never a
   * malformed topic. Bodies without a protocol topic never match;
   * checkpoints still advance past filtered rows exactly like every other
   * filter. */
  topic?: string;
  /** Optional body-kind filter: only envelopes whose body carries this exact
   * kind discriminator emit — the v2 `kind` field, a `worker-handoff`
   * assignment, a notice kind, a bus-transport v1 `protocol.kind` or a
   * `type`/`schema` notice discriminator, the same `busBodyKind` own-field
   * exact match `agents bus inbox --body-kind`, `channel read --body-kind`,
   * `agents bus wakes --body-kind`, `phm messages --body-kind` and
   * `agents conversations --body-kind` apply — matched exactly and
   * case-sensitively, so a body carrying no discriminator never matches and
   * an unrecognized but printable value is an honest empty match. Checkpoints
   * still advance past filtered rows exactly like every other filter. */
  bodyKind?: string;
  intervalMs?: number;
  /** Selects an existing local store; never creates or mutates inbox files. */
  root?: string;
}

export function validBusFollowRequest(request: BusFollowRequest): boolean {
  return Number.isSafeInteger(request.after) && request.after >= 0 &&
    Number.isSafeInteger(request.durationMs) && request.durationMs >= 1 && request.durationMs <= BUS_FOLLOW_MAX_DURATION_MS &&
    (request.to === undefined || label(request.to)) &&
    (request.channel === undefined || agentChannelNameSchema.safeParse(request.channel).success) &&
    (request.job === undefined || label(request.job)) &&
    (request.from === undefined || label(request.from)) &&
    (request.excludeFrom === undefined || label(request.excludeFrom)) &&
    (request.priority === undefined || BUS_PRIORITIES.includes(request.priority)) &&
    (request.thread === undefined || label(request.thread)) &&
    (request.since === undefined || (Number.isSafeInteger(request.since) && request.since >= 0)) &&
    (request.before === undefined || (Number.isSafeInteger(request.before) && request.before >= 0)) &&
    busReadContains(request.contains) !== null &&
    (request.id === undefined || label(request.id)) &&
    (request.inReplyTo === undefined || label(request.inReplyTo)) &&
    (request.kind === undefined || (BUS_PROTOCOL_KINDS as readonly string[]).includes(request.kind)) &&
    (request.topic === undefined || isTopicPattern(request.topic)) &&
    (request.bodyKind === undefined || label(request.bodyKind)) &&
    (request.intervalMs === undefined || (Number.isSafeInteger(request.intervalMs) &&
      request.intervalMs >= BUS_FOLLOW_MIN_INTERVAL_MS && request.intervalMs <= BUS_FOLLOW_MAX_INTERVAL_MS)) &&
    (request.root === undefined || (isAbsolute(request.root) && !request.root.includes('\0')));
}

export type BusFollowRecord =
  | { type: 'message'; cursor: number; receivedAt: number; envelope: BusEnvelope }
  | { type: 'checkpoint'; cursor: number };

export type BusFollowStatus = 'expired' | 'cancelled' | 'source-unavailable' | 'output-unavailable' | 'invalid';

export interface BusFollowResult {
  status: BusFollowStatus;
  /** Greatest checkpoint the output stream accepted: the safe at-least-once resume cursor. */
  cursor: number;
  /** Message records accepted by the output stream. */
  delivered: number;
  elapsedMs: number;
}

export interface BusFollowDependencies {
  /** Resolves when the record is accepted by the output stream; throws or rejects on failure. */
  emit: (record: BusFollowRecord) => void | Promise<void>;
  list?: typeof listBusInboxAfter;
  signal?: AbortSignal;
  /** Wall clock forwarded to the reader for TTL evaluation (defaults to Date.now). */
  now?: () => number;
  /** Monotonic millisecond clock for the deadline (defaults to performance.now). */
  clock?: () => number;
}

type OkPage = Extract<BusInboxPage, { status: 'ok' }>;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted || ms <= 0) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A page must report a non-regressing scan position over strictly ordered rows. */
function sanePage(page: OkPage, cursor: number): boolean {
  return Number.isSafeInteger(page.nextCursor) && page.nextCursor >= cursor &&
    page.messages.length <= BUS_INBOX_MAX_READ &&
    page.messages.every((row, index) => !!row &&
      Number.isSafeInteger(row.cursor) && row.cursor <= page.nextCursor &&
      row.cursor > (index === 0 ? cursor : page.messages[index - 1]!.cursor) &&
      Number.isSafeInteger(row.receivedAt) && row.receivedAt >= 0);
}

/** Polls the retained local inbox until the duration expires, emitting each live
 * matching receipt once and a checkpoint whenever the scan position advances.
 * A checkpoint is offered only after every preceding message record was
 * accepted, so the returned cursor is always a safe at-least-once resume point.
 * Retryable contention is retried within the deadline; unavailable, invalid or
 * malformed pages fail closed without emitting a falsely advanced checkpoint. */
export async function followBusStream(request: BusFollowRequest, deps: BusFollowDependencies): Promise<BusFollowResult> {
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  if (!validBusFollowRequest(request) || typeof deps.emit !== 'function') {
    return { status: 'invalid', cursor: 0, delivered: 0, elapsedMs: Math.max(0, Math.floor(clock() - started)) };
  }
  const deadline = started + request.durationMs;
  const interval = request.intervalMs ?? BUS_FOLLOW_DEFAULT_INTERVAL_MS;
  const list = deps.list ?? listBusInboxAfter;
  const options = { root: request.root, now: deps.now };
  const registryRead = readAgentRegistry({ root: request.root });
  const registry = registryRead.status === 'ok' ? registryRead.registry : undefined;
  const addressedTo = request.to === undefined ? () => true : agentPendingAddressMatcher(request.to, registry);
  const channelPrefix = request.channel === undefined ? undefined : `group:${request.channel}:`;
  const fromMatch = request.from === undefined ? undefined : agentRefAddressMatcher(request.from, registry);
  const excludeFromMatch = request.excludeFrom === undefined ? undefined : agentRefAddressMatcher(request.excludeFrom, registry);
  // The request passed validBusFollowRequest, so the needle is normalized text or absent.
  const containsNeedle = busReadContains(request.contains) ?? undefined;
  const emit = async (record: BusFollowRecord): Promise<boolean> => {
    try { await deps.emit(record); return true; } catch { return false; }
  };
  const aborted = (): boolean => deps.signal?.aborted === true;
  const pause = (): Promise<void> => wait(Math.max(0, Math.min(interval, deadline - clock())), deps.signal);
  let cursor = request.after, delivered = 0, status: BusFollowStatus = 'expired';
  try {
    for (;;) {
      if (aborted()) { status = 'cancelled'; break; }
      if (clock() >= deadline) break;
      const page = list(cursor, BUS_INBOX_MAX_READ, options);
      if (aborted()) { status = 'cancelled'; break; }
      if (page.status === 'retryable') { await pause(); continue; }
      if (page.status !== 'ok' || !sanePage(page, cursor)) { status = 'source-unavailable'; break; }
      let accepted = true;
      for (const row of page.messages) {
        if (!addressedTo(row.envelope.to, row.envelope.from)) continue;
        if (channelPrefix !== undefined && !row.envelope.to.startsWith(channelPrefix)) continue;
        if (request.id !== undefined && row.envelope.id !== request.id) continue;
        if (request.inReplyTo !== undefined && !busBodyInReplyToMatch(row.envelope.body, request.inReplyTo)) continue;
        if (request.job !== undefined && !busBodyJobMatch(row.envelope.body, request.job)) continue;
        if (fromMatch !== undefined && !fromMatch(row.envelope.from)) continue;
        if (excludeFromMatch !== undefined && excludeFromMatch(row.envelope.from)) continue;
        if (request.priority !== undefined && row.envelope.priority !== request.priority) continue;
        if (request.kind !== undefined && protocolOf(row.envelope.body)?.kind !== request.kind) continue;
        if (request.topic !== undefined && !topicMatches(request.topic, protocolOf(row.envelope.body)?.topic ?? '')) continue;
        if (request.thread !== undefined && busBodyThread(row.envelope.body) !== request.thread) continue;
        if (request.bodyKind !== undefined && busBodyKind(row.envelope.body) !== request.bodyKind) continue;
        if (request.since !== undefined && row.receivedAt < request.since) continue;
        if (request.before !== undefined && row.receivedAt >= request.before) continue;
        if (containsNeedle !== undefined && !busReadContainsMatch(row.envelope.body, containsNeedle)) continue;
        if (!(await emit({ type: 'message', cursor: row.cursor, receivedAt: row.receivedAt, envelope: row.envelope }))) {
          status = aborted() ? 'cancelled' : 'output-unavailable';
          accepted = false;
          break;
        }
        delivered += 1;
      }
      if (!accepted) break;
      if (page.nextCursor > cursor) {
        const next = page.nextCursor;
        if (!(await emit({ type: 'checkpoint', cursor: next }))) {
          status = aborted() ? 'cancelled' : 'output-unavailable';
          break;
        }
        cursor = next;
      }
      if (page.messages.length === BUS_INBOX_MAX_READ) continue;
      await pause();
    }
  } catch { status = 'source-unavailable'; }
  if (status === 'expired' && !(await emit({ type: 'checkpoint', cursor }))) status = 'output-unavailable';
  return { status, cursor, delivered, elapsedMs: Math.max(0, Math.floor(clock() - started)) };
}
