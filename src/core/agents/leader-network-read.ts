/** Read-only projection of the leader network's durable route and digest
 * state (`<runsDir>/leader/network-state.json`, written by
 * `createLeaderNetwork` in leader-network.ts). The network's own `pending()`
 * mutates recovery state under its writer lock, so surfaces that only need to
 * know what is queued or stuck read the file directly — the same bounded,
 * anchored read `readRouteReplyFacts` (fleet/order-thread-reply.ts) and
 * `leaderNetworkItemResolver` (fleet/order-result-bridge.ts) already apply.
 *
 * The projection carries only what pending-work surfaces may show: route
 * keys (sha256 digests, never owner ids), bus channel names, routing labels,
 * receipt/reply timestamps, the inbox/bus delivery legs, reply and digest
 * outcome flags, request text and the job ids a request body cites. Owner
 * recipient ids, channel refs, fingerprints and raw envelopes never leave
 * this module. A missing file is 'missing', a malformed or unsafe one is
 * 'unavailable' — never an empty backlog passed off as fact — and the read
 * never throws, takes no lock and writes nothing. */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { busBodyJobIds } from './bus-unified.js';

/** The writer's own MAX_RECORD_BYTES cap (leader-network.ts); the read never
 * accepts a larger state file than the writer can produce. */
export const LEADER_NETWORK_STATE_MAX_BYTES = 8 * 1024 * 1024;

const REQUEST_KEY = /^[a-f0-9]{64}$/;

/** The reply receipt a route recorded, reduced to the flags delivery state
 * needs — never the reply text or its fingerprint. */
export interface LeaderNetworkReplyFact {
  delivered: boolean;
  attempted: boolean;
  /** Epoch ms the reply was recorded (`reply.at`). */
  at: number;
}

/** One authenticated owner→leader (or owner→agent) route, reduced to the
 * delivery facts a pending-work read classifies on. */
export interface LeaderNetworkRequestFact {
  /** Route key — sha256 of [channel, envelope.id]; a digest, never an owner id. */
  requestId: string;
  /** Bus channel the verified owner used ('bus', 'telegram', 'email',
   * 'imessage', 'slack', ...). */
  channel: string;
  /** Routing label the routed envelope was addressed to — 'leader' for
   * owner→leader requests, an agent label otherwise. */
  to: string;
  /** Epoch ms the adapter receipt was recorded (`route.receivedAt`). */
  receivedAt: number;
  /** Request text when the body carries one (a string body or `body.text`);
   * raw — display layers scrub before it reaches an item. */
  text: string | null;
  /** The durable MASON-INBOX.md append is proven (`route.inbox`). For
   * leader-bound routes this is the leg the planner reads; for other routes
   * it only records that the adapter already wrote its own inbox. */
  inbox: boolean;
  /** The bus mirror is proven (`route.bus`). */
  bus: boolean;
  /** The reply receipt when one was recorded; null while unanswered. */
  reply: LeaderNetworkReplyFact | null;
  /** Job ids the request body cites under the shared `busBodyJobIds` rule. */
  jobIds: readonly string[];
}

/** One away-digest receipt, reduced to its delivery outcome. */
export interface LeaderNetworkDigestFact {
  /** Digest key — sha256 of [day, channel, owner id]; a digest, never an
   * owner id. */
  key: string;
  /** Bus channel the digest was addressed on (the stored envelope's
   * `channel` field — a channel name, never the recipient id). */
  channel: string;
  /** The UTC day the digest covers (`envelope.body.day`), when recorded. */
  day: string | null;
  /** Epoch ms the digest receipt was created (`digest.at`). */
  at: number;
  sent: boolean;
  attempted: boolean;
}

export type LeaderNetworkStateRead =
  | { status: 'missing' }
  | { status: 'unavailable' }
  | { status: 'ok'; requests: LeaderNetworkRequestFact[]; digests: LeaderNetworkDigestFact[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const safeMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The request text the network's own `inputText`/`messageText` rules accept:
 * a string body or an object body's `text` string, nothing else. */
function requestText(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (isRecord(body) && typeof body['text'] === 'string') return body['text'];
  return null;
}

function requestFact(requestId: string, route: Record<string, unknown>): LeaderNetworkRequestFact | null {
  const { channel, receivedAt, inbox, bus, message, reply } = route;
  if (typeof channel !== 'string' || channel.length === 0) return null;
  if (!safeMs(receivedAt) || typeof inbox !== 'boolean' || typeof bus !== 'boolean') return null;
  if (!isRecord(message) || typeof message['to'] !== 'string' || message['to'].length === 0) return null;
  let replyFact: LeaderNetworkReplyFact | null = null;
  if (reply !== undefined) {
    if (!isRecord(reply) || !safeMs(reply['at']) ||
        typeof reply['delivered'] !== 'boolean' || typeof reply['attempted'] !== 'boolean') return null;
    replyFact = { delivered: reply['delivered'], attempted: reply['attempted'], at: reply['at'] };
  }
  const body = message['body'];
  return {
    requestId,
    channel,
    to: message['to'],
    receivedAt,
    text: requestText(body),
    inbox,
    bus,
    reply: replyFact,
    jobIds: busBodyJobIds(body),
  };
}

function digestFact(key: string, receipt: Record<string, unknown>): LeaderNetworkDigestFact | null {
  const { at, sent, attempted, envelope } = receipt;
  if (!safeMs(at) || typeof sent !== 'boolean' || typeof attempted !== 'boolean') return null;
  if (!isRecord(envelope) || typeof envelope['channel'] !== 'string' || envelope['channel'].length === 0) return null;
  const body = envelope['body'];
  const day = isRecord(body) && typeof body['day'] === 'string' ? body['day'] : null;
  return { key, channel: envelope['channel'], day, at, sent, attempted };
}

/**
 * Read the leader network's durable state under `runsDir` (the shared runs
 * context — `~/.ashlr-runs` by default, resolved by the caller). Returns
 * 'missing' for a verified-absent file, 'unavailable' for an unreadable,
 * unsafe or malformed one — one bad route or digest fails the whole read
 * rather than reporting a partial backlog as complete, the same fail-closed
 * rule `readRouteReplyFacts` applies. Never throws.
 */
export function readLeaderNetworkState(options: { runsDir?: string } = {}): LeaderNetworkStateRead {
  const root = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const dir = join(root, 'leader');
  const file = join(dir, 'network-state.json');
  // readStableRegularFile folds a missing file into 'io-error', so absence is
  // probed first — the same ENOENT-only convention busPathMissing applies.
  try { lstatSync(file); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unavailable' };
  }
  const read = readStableRegularFile(file, {
    anchorPath: dir, maxFileBytes: LEADER_NETWORK_STATE_MAX_BYTES, remainingBytes: LEADER_NETWORK_STATE_MAX_BYTES,
  });
  if (!read.ok) return { status: 'unavailable' };
  try {
    const state: unknown = JSON.parse(read.text);
    if (!isRecord(state) || state['version'] !== 1 ||
        !isRecord(state['routes']) || !isRecord(state['digests'])) return { status: 'unavailable' };
    const requests: LeaderNetworkRequestFact[] = [];
    for (const [requestId, route] of Object.entries(state['routes'])) {
      if (!REQUEST_KEY.test(requestId) || !isRecord(route)) return { status: 'unavailable' };
      const fact = requestFact(requestId, route);
      if (fact === null) return { status: 'unavailable' };
      requests.push(fact);
    }
    const digests: LeaderNetworkDigestFact[] = [];
    for (const [key, receipt] of Object.entries(state['digests'])) {
      if (!REQUEST_KEY.test(key) || !isRecord(receipt)) return { status: 'unavailable' };
      const fact = digestFact(key, receipt);
      if (fact === null) return { status: 'unavailable' };
      digests.push(fact);
    }
    return { status: 'ok', requests, digests };
  } catch {
    return { status: 'unavailable' };
  }
}
