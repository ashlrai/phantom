/**
 * Post-admission read filters for `phm agentnet peers read`. Admission —
 * which envelopes a callsign may see — is decided entirely inside
 * `readPeerInbox` from the private coordination ledger and dispatch journal;
 * these filters only narrow the admitted page a session already receives, so
 * they grant no authority and can never widen what the session proves. Sender
 * and recipient labels match verbatim: callsigns and mapped topics are peer
 * labels, not bus registry identities, so nothing resolves through the agent
 * registry the way the local bus reads' `--from` does. The page cursor still
 * advances over every scanned row, so a filtered read is a view of the page,
 * not a subscription — an unfiltered poll sees everything.
 */
import { busBodyJobMatch, busReadContains, busReadContainsMatch } from '../agents/bus-unified.js';
import { busBodyKind, busBodyResultOutcome, busBodyThread,
  WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../agents/bus-v2-schema.js';
import { BUS_PRIORITIES, type BusEnvelope, type BusPriority } from '../fleet/bus-envelope.js';
import { parseSince } from '../fleet/agent-messages.js';

/** One admitted peer-inbox row: the durable cursor, receipt stamp and envelope. */
export interface PeerInboxMessage {
  cursor: number;
  receivedAt: number;
  envelope: BusEnvelope;
}

/** The kinds `peers send` accepts — the inner `peer.kind` a `--peer-kind`
 * filter matches; every other body kind reports null and never matches. */
export const PEER_MESSAGE_KINDS = ['task', 'review', 'handoff', 'query', 'social'] as const;
export type PeerMessageKind = typeof PEER_MESSAGE_KINDS[number];

/** The printable-label bound every bus read applies to id/label filter values. */
const LABEL = /^[\x21-\x7e]{1,128}$/;

export interface PeerInboxFilterInput {
  from?: string;
  excludeFrom?: string;
  to?: string;
  /** `15m`, `2h`, `1d`, epoch ms or an ISO time — the shared parseSince grammar. */
  since?: string;
  before?: string;
  contains?: string;
  id?: string;
  kind?: string;
  /** The shared bus reads' spelling of the same body-kind discriminator `kind` selects. */
  bodyKind?: string;
  /** One exact P0..P3 envelope band — the same match every other bus read's `--priority` applies. */
  priority?: string;
  peerKind?: string;
  thread?: string;
  job?: string;
  result?: string;
}

export interface PeerInboxFilters {
  from?: string;
  excludeFrom?: string;
  to?: string;
  /** Inclusive lower bound on `receivedAt`, epoch ms. */
  since?: number;
  /** Exclusive upper bound on `receivedAt`, epoch ms. */
  before?: number;
  /** Normalized case-insensitive needle matched against the shared body summary. */
  contains?: string;
  id?: string;
  /** Exact `busBodyKind` discriminator: `peer.message`, `work.post`, `work.status`, `work.result`, … */
  kind?: string;
  /** Exact envelope `priority` band; every admitted envelope carries the required field. */
  priority?: BusPriority;
  /** Exact inner kind of a `peer.message` body only. */
  peerKind?: PeerMessageKind;
  /** The conversation label a `peer.message` payload or note/context body carries. */
  thread?: string;
  job?: string;
  result?: WorkResultOutcome;
}

export type PeerInboxQuery = { ok: true; filters: PeerInboxFilters } | { ok: false };

/** Label validation shared by the verbatim-match fields: absent stays absent,
 * a value outside the printable bound is a usage error (`null`), never a
 * silently empty page. */
function label(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return LABEL.test(value) ? value : null;
}

/** Shared validation for the CLI flags; `now` anchors the relative time grammar once per read. */
export function parsePeerInboxFilters(input: PeerInboxFilterInput, now = Date.now()): PeerInboxQuery {
  const filters: PeerInboxFilters = {};
  for (const key of ['from', 'excludeFrom', 'to', 'id', 'kind', 'thread', 'job'] as const) {
    const value = label(input[key]);
    if (value === null) return { ok: false };
    if (value !== undefined) filters[key] = value;
  }
  // `--body-kind` is the shared bus reads' spelling of the same
  // body-kind discriminator `--kind` selects here; both may appear but
  // must agree — a conflict is a usage error, never a widened read.
  const bodyKind = label(input.bodyKind);
  if (bodyKind === null) return { ok: false };
  if (bodyKind !== undefined) {
    if (filters.kind !== undefined && filters.kind !== bodyKind) return { ok: false };
    filters.kind = bodyKind;
  }
  if (input.priority !== undefined) {
    // The same P0..P3 vocabulary every other bus read's --priority
    // validates, so the flag can never disagree about which bands an
    // envelope can carry.
    if (!(BUS_PRIORITIES as readonly string[]).includes(input.priority)) return { ok: false };
    filters.priority = input.priority as BusPriority;
  }
  if (input.peerKind !== undefined) {
    // The same closed set `peerRequestSchema` enforces on send — an unknown
    // kind is a usage error, never a silent empty page.
    if (!(PEER_MESSAGE_KINDS as readonly string[]).includes(input.peerKind)) return { ok: false };
    filters.peerKind = input.peerKind as PeerMessageKind;
  }
  if (input.result !== undefined) {
    // The same WORK_RESULT_OUTCOMES enum every other bus read's --result
    // validates, so the flag can never disagree about which codes a
    // work.result body can report.
    if (!(WORK_RESULT_OUTCOMES as readonly string[]).includes(input.result)) return { ok: false };
    filters.result = input.result as WorkResultOutcome;
  }
  if (input.since !== undefined) {
    const since = parseSince(input.since, now);
    if (since === null) return { ok: false };
    filters.since = since;
  }
  if (input.before !== undefined) {
    const before = parseSince(input.before, now);
    if (before === null) return { ok: false };
    filters.before = before;
  }
  const needle = busReadContains(input.contains);
  if (needle === null) return { ok: false };
  if (needle !== undefined) filters.contains = needle;
  return { ok: true, filters };
}

/** The conversation label a peer-inbox body carries: a `note`/`context` body's
 * v2 `thread` through the shared `busBodyThread` rule, or a `peer.message`
 * payload's own `threadId` — the label `peers send --thread` stamps. Work
 * bodies carry no thread and never match. */
function peerBodyThread(body: unknown): string | null {
  const shared = busBodyThread(body);
  if (shared !== null) return shared;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record['kind'] !== 'peer.message') return null;
  const peer = record['peer'];
  if (peer === null || typeof peer !== 'object' || Array.isArray(peer)) return null;
  const threadId = (peer as Record<string, unknown>)['threadId'];
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

/** The inner kind a `peer.message` body carries (`task`, `review`, …);
 * every other body kind reports null and never matches `--peer-kind`. */
function peerMessageKind(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record['kind'] !== 'peer.message') return null;
  const peer = record['peer'];
  if (peer === null || typeof peer !== 'object' || Array.isArray(peer)) return null;
  const kind = (peer as Record<string, unknown>)['kind'];
  return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

/**
 * One admitted row against the parsed filters — every check is an exact
 * own-field or shared-projection match, the same rules the local bus reads
 * apply, so a filtered peer read can never disagree with them about what a
 * filter means. `from`/`excludeFrom`/`to` compare the envelope's own labels
 * verbatim (callsigns and mapped topics, never registry-resolved);
 * `priority` is the same exact P0..P3 band match every other bus read
 * applies; `since`/`before` compose one `[since, before)` window on
 * `receivedAt`;
 * `contains` matches the shared scrubbed body summary; `kind`, `job`,
 * `result` and the reply/thread citations read the same body fields every
 * other bus read's filters do.
 */
export function peerInboxMessageMatches(message: PeerInboxMessage, filters: PeerInboxFilters): boolean {
  const { envelope } = message;
  if (filters.from !== undefined && envelope.from !== filters.from) return false;
  if (filters.excludeFrom !== undefined && envelope.from === filters.excludeFrom) return false;
  if (filters.to !== undefined && envelope.to !== filters.to) return false;
  if (filters.id !== undefined && envelope.id !== filters.id) return false;
  if (filters.priority !== undefined && envelope.priority !== filters.priority) return false;
  if (filters.since !== undefined && message.receivedAt < filters.since) return false;
  if (filters.before !== undefined && message.receivedAt >= filters.before) return false;
  const body = envelope.body;
  if (filters.contains !== undefined && !busReadContainsMatch(body, filters.contains)) return false;
  if (filters.kind !== undefined && busBodyKind(body) !== filters.kind) return false;
  if (filters.peerKind !== undefined && peerMessageKind(body) !== filters.peerKind) return false;
  if (filters.thread !== undefined && peerBodyThread(body) !== filters.thread) return false;
  if (filters.job !== undefined && !busBodyJobMatch(body, filters.job)) return false;
  if (filters.result !== undefined && busBodyResultOutcome(body) !== filters.result) return false;
  return true;
}
