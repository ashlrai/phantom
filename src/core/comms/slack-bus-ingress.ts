/**
 * Opt-in Slack Events API ingress into the existing local agent bus.
 * No listener, token resolver, send path, model call or work launcher lives here.
 * Signatures authenticate transport; text and context references remain untrusted.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { appendBusInbox, type BusInboxPost, type BusInboxOptions } from '../fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { scrubSecrets } from '../util/scrub.js';

const MAX_AGE_MS = 300_000;
const FUTURE_SKEW_MS = 5_000;
// Keep receipts past the entire event admission window, so pruning cannot make
// an authenticated replay a fresh post. This is not eternal exactly-once storage.
const RECEIPT_TTL_MS = 360_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_HOPS = 4;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}(?![\s\S])/;
const SLACK_ID = /^[A-Z][A-Z0-9]{1,63}(?![\s\S])/;
const SLACK_TS = /^\d{10}\.\d{6}(?![\s\S])/;
const KINDS = ['request', 'reply', 'note', 'status', 'decision', 'context'] as const;

export interface SlackBusPeer {
  botId: string; appId: string; userId: string;
  /** Installed policy mapping, never an agent name claimed in message text. */
  agentId: string; vendor: string; bridgeId: string;
}
export interface SlackBusRoute {
  channelId: string;
  /** Only dedicated fleet coordination audiences may be configured here. */
  audience: 'fleet-coordination';
  mode: 'peer' | 'group';
  peerBotIds: readonly string[];
  recipients: readonly string[];
}
export interface SlackBusIngressPolicy {
  enabled: boolean;
  workspaceId: string; receiverAppId: string;
  selfBotId: string; selfUserId: string; bridgeId: string;
  peers: readonly SlackBusPeer[];
  routes: readonly SlackBusRoute[];
}
export interface SlackEventRequest {
  /** Exact UTF-8 request bytes decoded without normalization by the HTTP owner. */
  rawBody: string;
  timestamp: string;
  signature: string;
}
export interface SlackContextReference {
  id: string; revision: string; observedAt: number; expiresAt: number;
}
export interface SlackBusIngressOptions {
  /** Explicit private local store root. No implicit read/write of real HOME. */
  root: string;
  /** Read current trusted installation policy on every receive; absence disables. */
  readPolicy: () => SlackBusIngressPolicy | undefined;
  /** Owner supplies ephemeral custody output; never read from event/config/logs. */
  readSigningSecret: () => string | undefined;
  now?: () => number;
  /** Trusted test seam; success must mean durable local persistence. */
  append?: (envelope: BusEnvelope, options: BusInboxOptions) => BusInboxPost;
}
export interface SlackBusIngressResult {
  status: 'disabled' | 'refused' | 'ignored' | 'accepted' | 'partial';
  reason: string;
  posted: number;
  duplicates: number;
  /** No outward message or execution is authorized by local acceptance. */
  sendAuthorized: false;
}
const result = (status: SlackBusIngressResult['status'], reason: string, posted = 0, duplicates = 0): SlackBusIngressResult =>
  ({ status, reason, posted, duplicates, sendAuthorized: false });
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v) && scrubSecrets(v) === v;
const slackId = (v: unknown): v is string => typeof v === 'string' && SLACK_ID.test(v);
const unique = (items: readonly string[]) => new Set(items).size === items.length;
const at = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const ageValid = (then: number, now: number) => now - then <= MAX_AGE_MS && then - now <= FUTURE_SKEW_MS;

function validPolicy(p: SlackBusIngressPolicy): boolean {
  if (!record(p) || p.enabled !== true || ![p.workspaceId, p.receiverAppId, p.selfBotId, p.selfUserId].every(slackId) ||
      !token(p.bridgeId) || !Array.isArray(p.peers) || p.peers.length < 1 || p.peers.length > 32 ||
      !Array.isArray(p.routes) || p.routes.length < 1 || p.routes.length > 32) return false;
  if (p.peers.some(peer => !record(peer) || ![peer.botId, peer.appId, peer.userId].every(slackId) ||
      !token(peer.agentId) || !token(peer.vendor) || !token(peer.bridgeId) ||
      peer.agentId.toLowerCase() === 'mason' || peer.botId === p.selfBotId || peer.userId === p.selfUserId ||
      peer.appId === p.receiverAppId || peer.bridgeId === p.bridgeId) ||
      !unique(p.peers.map(peer => peer.botId)) || !unique(p.peers.map(peer => peer.userId)) ||
      !unique(p.peers.map(peer => peer.agentId))) return false;
  return unique(p.routes.map(route => route.channelId)) && p.routes.every(route =>
    record(route) && slackId(route.channelId) && route.audience === 'fleet-coordination' &&
    (route.mode === 'peer' || route.mode === 'group') && Array.isArray(route.recipients) &&
    route.recipients.length >= 1 && route.recipients.length <= (route.mode === 'peer' ? 1 : 16) &&
    route.recipients.every(token) && unique(route.recipients) &&
    Array.isArray(route.peerBotIds) && route.peerBotIds.length >= 1 && route.peerBotIds.length <= 32 &&
    unique(route.peerBotIds) && route.peerBotIds.every(id => p.peers.some(peer => peer.botId === id)));
}

/** Compare the HMAC over exact raw bytes; no parsed field can assert verification. */
export function verifySlackEventSignature(request: SlackEventRequest, secret: string, now: number): boolean {
  if (!at(now) || typeof secret !== 'string' || secret.length < 16 || secret.length > 4096 ||
      typeof request?.rawBody !== 'string' || request.rawBody.length > MAX_BODY_BYTES ||
      Buffer.byteLength(request.rawBody, 'utf8') > MAX_BODY_BYTES ||
      typeof request.timestamp !== 'string' || !/^\d{10}(?![\s\S])/.test(request.timestamp) ||
      typeof request.signature !== 'string' || !/^v0=[0-9a-f]{64}(?![\s\S])/.test(request.signature)) return false;
  const timestamp = Number(request.timestamp) * 1000;
  if (!at(timestamp) || !ageValid(timestamp, now)) return false;
  const expected = createHmac('sha256', secret).update(`v0:${request.timestamp}:${request.rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(request.signature.slice(3), 'hex'));
}

function contextReferences(value: unknown): SlackContextReference[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return null;
  const refs: SlackContextReference[] = [];
  for (const ref of value) {
    if (!record(ref) || Object.keys(ref).sort().join() !== 'expiresAt,id,observedAt,revision' ||
        !token(ref.id) || !token(ref.revision) || !at(ref.observedAt) || !at(ref.expiresAt) ||
        ref.expiresAt <= ref.observedAt || refs.some(prior => prior.id === ref.id)) return null;
    refs.push({ id: ref.id, revision: ref.revision, observedAt: ref.observedAt, expiresAt: ref.expiresAt });
  }
  return refs;
}

/**
 * Actual bus integration, dormant until called by an explicitly enabled owner.
 * Group fanout is bounded and separately durable, not an all-or-nothing commit.
 * A retry can finish partial fanout through the bus's exact-envelope dedupe.
 */
export function createSlackBusIngress(options: SlackBusIngressOptions): (request: SlackEventRequest) => SlackBusIngressResult {
  const root = options.root;
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new Error('Explicit private bus root required.');
  let lastNow = 0;
  return request => {
    try {
      const supplied = options.readPolicy();
      if (!supplied || supplied.enabled !== true) return result('disabled', 'not-enabled');
      // Detach current trusted policy before processing untrusted transport data.
      const policy = structuredClone(supplied);
      if (!validPolicy(policy)) return result('refused', 'invalid-policy');
      const now = (options.now ?? Date.now)();
      if (!at(now) || now < lastNow) return result('refused', 'invalid-clock');
      lastNow = now;
      const secret = options.readSigningSecret();
      if (!secret || !verifySlackEventSignature(request, secret, now)) return result('refused', 'unverified-transport');
      const payload: unknown = JSON.parse(request.rawBody);
      if (!record(payload) || payload.type !== 'event_callback' || payload.team_id !== policy.workspaceId ||
          payload.api_app_id !== policy.receiverAppId || payload.is_ext_shared_channel !== false ||
          !token(payload.event_id) || !record(payload.event)) return result('refused', 'invalid-event');
      const event = payload.event;
      if (!['message', 'app_mention'].includes(String(event.type)) ||
          (event.subtype !== undefined && event.subtype !== 'bot_message')) return result('ignored', 'unsupported-event');
      if (event.bot_id === policy.selfBotId || event.user === policy.selfUserId || event.app_id === policy.receiverAppId) {
        return result('ignored', 'self-echo');
      }
      const route = policy.routes.find(row => row.channelId === event.channel);
      const peer = policy.peers.find(row => row.botId === event.bot_id && row.appId === event.app_id && row.userId === event.user);
      if (!route || !peer || !route.peerBotIds.includes(peer.botId)) return result('refused', 'actor-or-channel-not-allowed');
      if (event.team !== undefined && event.team !== policy.workspaceId) return result('refused', 'workspace-mismatch');
      if (typeof event.ts !== 'string' || !SLACK_TS.test(event.ts) ||
          (event.thread_ts !== undefined && (typeof event.thread_ts !== 'string' || !SLACK_TS.test(event.thread_ts))) ||
          !ageValid(Number(event.ts) * 1000, now) || typeof event.text !== 'string' || !event.text.trim() ||
          event.text.length > MAX_TEXT_BYTES || Buffer.byteLength(event.text, 'utf8') > MAX_TEXT_BYTES ||
          scrubSecrets(event.text) !== event.text) return result('refused', 'invalid-content');
      const metadata = event.metadata;
      const protocol = record(metadata) ? metadata.event_payload : undefined;
      if (!record(metadata) || metadata.event_type !== 'phantom_agent_message' || !record(protocol) || protocol.version !== 1 ||
          !KINDS.includes(protocol.kind as typeof KINDS[number]) || !token(protocol.message_id) ||
          !token(protocol.origin_bridge) || !Array.isArray(protocol.visited_bridges) ||
          protocol.visited_bridges.length < 1 || protocol.visited_bridges.length >= MAX_HOPS ||
          !protocol.visited_bridges.every(token) || !unique(protocol.visited_bridges) ||
          protocol.hop_count !== protocol.visited_bridges.length || protocol.visited_bridges[0] !== protocol.origin_bridge ||
          protocol.visited_bridges.at(-1) !== peer.bridgeId ||
          (protocol.in_reply_to !== undefined && !token(protocol.in_reply_to))) return result('refused', 'invalid-peer-protocol');
      if (protocol.visited_bridges.includes(policy.bridgeId)) return result('ignored', 'bridge-echo');
      const references = contextReferences(protocol.context_refs);
      if (references === null) return result('refused', 'invalid-context-references');
      const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : event.ts;
      const envelopes: BusEnvelope[] = [];
      for (const recipient of route.recipients) {
        const id = `slack:${createHash('sha256').update(JSON.stringify([policy.workspaceId, payload.event_id, recipient])).digest('hex')}`;
        const checked = validateBusEnvelope({
          id, from: peer.agentId, to: recipient, priority: 'P2', ttl: RECEIPT_TTL_MS,
          channel: 'slack', channel_ref: `${policy.workspaceId}/${route.channelId}/${threadTs}`,
          sender: { agent_id: peer.agentId, vendor: peer.vendor, human: false, team: true },
          external: false, origin_bridge: protocol.origin_bridge,
          body: {
            kind: 'slack-coordination', trust: 'untrusted', messageType: protocol.kind,
            text: event.text, messageId: protocol.message_id, inReplyTo: protocol.in_reply_to ?? null,
            workspaceId: policy.workspaceId, channelId: route.channelId, threadTs, eventTs: event.ts,
            routeMode: route.mode, originBridge: protocol.origin_bridge,
            visitedBridges: [...protocol.visited_bridges, policy.bridgeId],
            context: { references, trust: 'unverified-reference-claims', retrievalAuthorized: false },
          },
        });
        if (!checked.ok) return result('refused', 'invalid-bus-envelope');
        envelopes.push(checked.value);
      }
      let posted = 0, duplicates = 0;
      for (const envelope of envelopes) {
        let receipt: BusInboxPost;
        try { receipt = (options.append ?? appendBusInbox)(envelope, { root, now: () => now }); }
        catch { return result('partial', 'storage-unconfirmed', posted, duplicates); }
        if (receipt.status === 'posted') posted++;
        else if (receipt.status === 'duplicate') duplicates++;
        else return result('partial', `storage-${receipt.status}`, posted, duplicates);
      }
      return result('accepted', 'persisted-locally', posted, duplicates);
    } catch { return result('refused', 'ingress-unavailable'); }
  };
}
