/**
 * Slack -> Agent Bus inbound mapping (RQ-AGENTNET-SLACK-1).
 *
 * Pure decision layer for one Socket Mode event, plus a composed local ingest
 * that journals the decision and publishes accepted envelopes to the durable
 * local bus store (`appendBusInbox`). No WebSocket, no Web API call and no
 * credential anywhere in this file -- the socket owner and the token-bearing
 * poster land in the separately reviewed `-sec` change.
 *
 * Rules (docs/research/AGENT-NETWORK-RESEARCH.md, "Slack"):
 *   - only `message` (plain / `bot_message` / `thread_broadcast`) and
 *     `app_mention` events are candidates; every other event is ignored,
 *   - the event's workspace must equal `slack.team_id`,
 *   - the channel must be bound to a bus topic by `[[slack.map]]`,
 *   - the author must be an allowlisted `[team]` identity for `slack`
 *     (humans by U…/W… id, team agents by B… bot id),
 *   - anything the bridge itself authored is dropped before the allowlist --
 *     the loop guard (`own_user_id` / `own_bot_id`),
 *   - everything ignored is recorded by reason code, ids and the `messageTs`/
 *     `threadTs` pair only (once the event reached channel validation), never
 *     text.
 *
 * Accepted events become channel-aware envelopes (`channel: 'slack'`, the full
 * metadata group) addressed to the mapped topic with `body.kind: 'note'`; the
 * Slack thread root maps to the deterministic `slack:<team>:<channel>:<ts>`
 * thread ref from slack-network.ts. Text is untrusted data -- oversized,
 * empty and secret-shaped bodies are refused, never truncated or scrubbed
 * into the store.
 */
import { appendBusInbox, type BusInboxPost } from '../fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import { scrubSecrets } from '../util/scrub.js';
import { BUS_V2_TEXT_MAX } from './bus-v2-schema.js';
import type { TeamIdentity } from './channel-policy.js';
import {
  isSlackAuthorId, isSlackBotId, isSlackChannelId, isSlackSelfId, isSlackTeamIdentity,
  isSlackTs, isSlackUserId, slackThreadRef, slackTopicForChannel,
  type SlackBridgeConfig,
} from './slack-network.js';
import { recordSlackObservation } from './slack-journal.js';

export type SlackIgnoreReason =
  | 'unsupported-envelope-type'
  | 'unsupported-event-type'
  | 'unsupported-subtype'
  | 'hidden-event'
  | 'malformed-event'
  | 'foreign-team'
  | 'unmapped-channel'
  | 'self-message'
  | 'untrusted-sender'
  | 'empty-text'
  | 'oversize-text'
  | 'secret-shaped-text';

export type SlackInboundDecision =
  | { status: 'ingest'; envelope: BusEnvelope }
  | { status: 'ignore'; reason: SlackIgnoreReason };

export interface SlackSocketEnvelope {
  /** Socket Mode `envelope_id` -- the value the ack returns. Bounded metadata only. */
  envelopeId: string;
  /** Slack Events API `event_id` when present (ids only, never payload text). */
  eventId?: string;
  event: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    ? value
    : undefined;
}

/**
 * Unwrap one Socket Mode delivery. Only `events_api` envelopes carry channel
 * events; `interactive`, `slash_commands`, `hello` and `disconnect` payloads are
 * not bus input. Returns ids for journaling plus the raw inner event.
 */
export function unwrapSlackSocketEnvelope(raw: unknown): SlackSocketEnvelope | { reason: SlackIgnoreReason } {
  if (!record(raw) || raw['type'] !== 'events_api' || !record(raw['payload']) || !record(raw['payload']['event'])) {
    return { reason: 'unsupported-envelope-type' };
  }
  return {
    envelopeId: boundedId(raw['envelope_id']) ?? 'unknown',
    ...(boundedId(raw['payload']['event_id']) ? { eventId: boundedId(raw['payload']['event_id']) } : {}),
    // Slack binds the workspace on the Events API callback, not every inner
    // message. Preserve that authenticated scope without accepting a conflict.
    event: {
      ...raw['payload']['event'],
      team: raw['payload']['team_id'] !== undefined && raw['payload']['event']['team'] !== undefined &&
        raw['payload']['team_id'] !== raw['payload']['event']['team']
        ? undefined : raw['payload']['team_id'] ?? raw['payload']['event']['team'],
    },
  };
}

function authorOf(event: Record<string, unknown>): { id: string; human: boolean } | undefined {
  const bot = isSlackBotId(event['bot_id']) ? event['bot_id'] : undefined;
  const user = isSlackUserId(event['user']) ? event['user'] : undefined;
  const id = bot ?? user;
  if (id === undefined) return undefined;
  // A bot-authored event reports its bot id; `user` there is the bot's own user.
  return { id, human: bot === undefined && event['subtype'] !== 'bot_message' };
}

/**
 * Map one Events API event to a bus envelope or a static ignore reason.
 * Deterministic: the same Slack `(team, channel, ts)` always yields the same
 * envelope id, so Socket Mode redelivery dedupes at the bus store.
 */
export function slackEventToBus(
  event: unknown,
  ctx: { config: SlackBridgeConfig; teamIdentities: readonly TeamIdentity[] },
): SlackInboundDecision {
  if (!record(event)) return { status: 'ignore', reason: 'malformed-event' };
  const { config } = ctx;
  if (event['hidden'] === true) return { status: 'ignore', reason: 'hidden-event' };
  const type = event['type'];
  const subtype = event['subtype'];
  if (type === 'message' && typeof subtype === 'string' && subtype !== 'bot_message' && subtype !== 'thread_broadcast') {
    return { status: 'ignore', reason: 'unsupported-subtype' };
  }
  if (type !== 'message' && type !== 'app_mention') return { status: 'ignore', reason: 'unsupported-event-type' };
  if (event['team'] !== config.teamId) return { status: 'ignore', reason: 'foreign-team' };
  if (!isSlackChannelId(event['channel'])) return { status: 'ignore', reason: 'malformed-event' };
  const topic = slackTopicForChannel(config, event['channel']);
  if (topic === undefined) return { status: 'ignore', reason: 'unmapped-channel' };
  if (!isSlackTs(event['ts'])) return { status: 'ignore', reason: 'malformed-event' };
  const ts = event['ts'];
  if (Object.hasOwn(event, 'thread_ts') && !isSlackTs(event['thread_ts'])) return { status: 'ignore', reason: 'malformed-event' };
  const rootTs = isSlackTs(event['thread_ts']) ? event['thread_ts'] : ts;
  const author = authorOf(event);
  if (author === undefined) return { status: 'ignore', reason: 'malformed-event' };
  // Loop guard before the allowlist: a bridge-authored echo is never re-ingested,
  // even on the (misconfigured) day its own ids appear in [team].
  if (isSlackSelfId(config, author.id)) return { status: 'ignore', reason: 'self-message' };
  if (!isSlackTeamIdentity(ctx.teamIdentities, author.id)) return { status: 'ignore', reason: 'untrusted-sender' };
  if (typeof event['text'] !== 'string') return { status: 'ignore', reason: 'empty-text' };
  const text = event['text'].normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) return { status: 'ignore', reason: 'empty-text' };
  if (text.length > BUS_V2_TEXT_MAX) return { status: 'ignore', reason: 'oversize-text' };
  if (scrubSecrets(text) !== text) return { status: 'ignore', reason: 'secret-shaped-text' };
  const channelId = event['channel'];
  const threadRef = slackThreadRef(config.teamId, channelId, rootTs);
  const candidate: BusEnvelope = {
    id: `slack-${config.teamId}-${channelId}-${ts}`,
    from: `slack:${author.id}`,
    to: topic,
    priority: 'P2',
    ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: 'note',
      text,
      thread: threadRef,
      refs: [`slack:${config.teamId}:${channelId}:${ts}`],
    },
    channel: 'slack',
    channel_ref: threadRef,
    sender: { agent_id: author.id, vendor: 'slack', human: author.human, team: true },
    external: false,
    origin_bridge: config.bridgeId,
  };
  const checked = validateBusEnvelope(candidate);
  return checked.ok ? { status: 'ingest', envelope: checked.value } : { status: 'ignore', reason: 'malformed-event' };
}

// ---------------------------------------------------------------------------
// Composed local ingest: parse -> decide -> journal -> publish to the local bus.
// ---------------------------------------------------------------------------

export interface SlackIngestContext {
  config: SlackBridgeConfig;
  teamIdentities: readonly TeamIdentity[];
  /** Bus store root (`appendBusInbox`); default the canonical store. */
  busRoot?: string;
  /** Journal root (`~/.ashlr-runs` convention). */
  runsDir?: string;
  now?: () => Date;
  /** Test seam for the store append. */
  publish?: (envelope: BusEnvelope) => BusInboxPost;
}

export interface SlackIngestResult {
  decision: 'ingested' | 'ignored';
  reason?: SlackIgnoreReason;
  /** Socket Mode envelope/event ids for the ack path -- metadata only. */
  envelopeId?: string;
  eventId?: string;
  bus?: 'posted' | 'duplicate' | 'failed';
  envelope?: BusEnvelope;
}

/**
 * One delivery, end to end, offline except for the local bus append the caller
 * owns. Never throws; every outcome is journaled by ids, the `messageTs`/
 * `threadTs` pair and reason code only -- never text.
 */
export function ingestSlackSocketMessage(raw: unknown, ctx: SlackIngestContext): SlackIngestResult {
  const now = ctx.now ?? (() => new Date());
  const unwrapped = unwrapSlackSocketEnvelope(raw);
  if ('reason' in unwrapped) {
    recordSlackObservation({ at: now().toISOString(), decision: 'ignored', reason: unwrapped.reason }, { runsDir: ctx.runsDir });
    return { decision: 'ignored', reason: unwrapped.reason };
  }
  const base = { envelopeId: unwrapped.envelopeId, ...(unwrapped.eventId ? { eventId: unwrapped.eventId } : {}) };
  const event = record(unwrapped.event) ? unwrapped.event : {};
  const channelId = isSlackChannelId(event['channel']) ? event['channel'] : undefined;
  const author = authorOf(event);
  // The same ts pair slackEventToBus builds its thread ref from: the event's
  // own `ts`, and the thread root (`thread_ts` when valid, else that `ts`).
  // Journaled only when `ts` is a real Slack ts -- ids, never text.
  const messageTs = isSlackTs(event['ts']) ? event['ts'] : undefined;
  const threadTs = messageTs !== undefined && isSlackTs(event['thread_ts']) ? event['thread_ts'] : messageTs;
  const tsMeta = messageTs === undefined ? {} : { messageTs, threadTs: threadTs ?? messageTs };
  const decided = slackEventToBus(event, ctx);
  if (decided.status === 'ignore') {
    // slackEventToBus drops for envelope, hidden, subtype, type and team
    // before the channel check; only rows that reached channel validation
    // journal the ts pair.
    const reachedChannelValidation =
      decided.reason !== 'unsupported-envelope-type' &&
      decided.reason !== 'hidden-event' &&
      decided.reason !== 'unsupported-subtype' &&
      decided.reason !== 'unsupported-event-type' &&
      decided.reason !== 'foreign-team';
    recordSlackObservation({
      at: now().toISOString(), ...base,
      ...(channelId ? { channelId } : {}),
      ...(reachedChannelValidation ? tsMeta : {}),
      ...(author && isSlackAuthorId(author.id) ? { authorId: author.id } : {}),
      decision: 'ignored', reason: decided.reason,
    }, { runsDir: ctx.runsDir });
    return { decision: 'ignored', reason: decided.reason, ...base };
  }
  let bus: SlackIngestResult['bus'] = 'failed';
  try {
    const post = ctx.publish
      ? ctx.publish(decided.envelope)
      : appendBusInbox(decided.envelope, { root: ctx.busRoot, now: () => now().getTime() });
    bus = post.status === 'posted' || post.status === 'duplicate' ? post.status : 'failed';
  } catch {
    bus = 'failed';
  }
  recordSlackObservation({
    at: now().toISOString(), ...base,
    ...(channelId ? { channelId } : {}),
    ...tsMeta,
    authorId: author!.id,
    decision: 'ingested',
    ...(bus ? { bus } : {}),
  }, { runsDir: ctx.runsDir });
  return { decision: 'ingested', ...base, bus, envelope: decided.envelope };
}
