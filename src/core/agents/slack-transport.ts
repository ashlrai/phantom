/** Authenticated Slack transport over the existing bus; credentials never enter receipts. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { evaluateSlackAudience, slackOutboundPlan, slackSendDecision, type SlackAudienceSnapshot, type SlackMemberSnapshot } from './slack-audience.js';
import { ingestSlackSocketMessage, slackEventToBus, unwrapSlackSocketEnvelope, type SlackIngestContext } from './slack-inbound.js';
import { isSlackChannelId, isSlackTs, type SlackBridgeConfig } from './slack-network.js';
import type { TeamIdentity } from './channel-policy.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const MAX_REPLY_BYTES = 1024 * 1024;
export type SlackCall = (method: string, input?: RecordValue, credential?: 'bot' | 'app') => Promise<RecordValue>;

/** Fixed API origin, no redirects or retries, bounded bodies and static errors. */
export function createSlackApi(input: {
  config: SlackBridgeConfig;
  resolveCredential: (reference: string) => string | undefined;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): SlackCall {
  return async (method, body = {}, credential = 'bot') => {
    if (input.signal?.aborted) throw new Error('slack-session-expired');
    if (!['auth.test', 'apps.connections.open', 'conversations.info', 'conversations.members', 'users.info', 'chat.postMessage', 'conversations.history', 'conversations.replies'].includes(method)) {
      throw new Error('slack-method-refused');
    }
    const ref = credential === 'app' ? input.config.appTokenRef : input.config.botTokenRef;
    const token = ref ? input.resolveCredential(ref) : undefined;
    if (!token) throw new Error('slack-credential-unavailable');
    const json = method === 'chat.postMessage';
    const encoded = json ? JSON.stringify(body) : new URLSearchParams(Object.entries(body)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)])).toString();
    let response: Response;
    try {
      response = await (input.fetch ?? fetch)(`https://slack.com/api/${method}`, {
        method: 'POST', redirect: 'error', signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded; charset=utf-8' },
        body: encoded,
      });
    } catch { throw new Error('slack-network-uncertain'); }
    if (response.status === 429) throw new Error('slack-rate-limited');
    if (!response.ok) throw new Error('slack-http-failed');
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error('slack-response-invalid');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read().catch(() => { throw new Error('slack-network-uncertain'); });
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_REPLY_BYTES) { await reader.cancel().catch(() => {}); throw new Error('slack-response-too-large'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    let result: unknown;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('slack-response-invalid'); }
    if (!record(result) || result.ok !== true) throw new Error('slack-api-refused');
    return result;
  };
}

export async function verifySlackIdentity(call: SlackCall, config: SlackBridgeConfig): Promise<void> {
  const identity = await call('auth.test');
  if (identity.team_id !== config.teamId || !config.ownUserId || identity.user_id !== config.ownUserId ||
      !config.ownBotId || identity.bot_id !== config.ownBotId) throw new Error('slack-identity-mismatch');
}

/** Page the actual authenticated membership, then bind every user to this team. */
export async function observeSlackAudience(call: SlackCall, channel: string): Promise<SlackAudienceSnapshot> {
  if (!isSlackChannelId(channel)) throw new Error('slack-channel-invalid');
  const info = await call('conversations.info', { channel });
  if (!record(info.channel) || info.channel.id !== channel) throw new Error('slack-channel-mismatch');
  const ids: string[] = []; const cursors = new Set<string>(); let cursor = '';
  for (let page = 0; page < 16; page++) {
    const result = await call('conversations.members', { channel, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.members) || result.members.some(id => typeof id !== 'string') || ids.length + result.members.length > 512) throw new Error('slack-membership-incomplete');
    for (const id of result.members as string[]) {
      if (ids.includes(id)) throw new Error('slack-membership-duplicate');
      ids.push(id);
    }
    const metadata = result.response_metadata;
    if (metadata !== undefined && !record(metadata)) throw new Error('slack-membership-invalid');
    const next = record(metadata) ? metadata.next_cursor : undefined;
    if (next !== undefined && typeof next !== 'string') throw new Error('slack-membership-invalid');
    cursor = typeof next === 'string' ? next.trim() : '';
    if (!cursor) break;
    if (cursors.has(cursor) || page === 15) throw new Error('slack-membership-incomplete');
    cursors.add(cursor);
  }
  const members: SlackMemberSnapshot[] = [];
  for (const id of ids) {
    const result = await call('users.info', { user: id });
    if (!record(result.user) || result.user.id !== id) throw new Error('slack-member-mismatch');
    members.push(result.user as unknown as SlackMemberSnapshot);
  }
  return { conversation: info.channel, members, complete: true };
}

interface SendReceipt { digest: string; clientId: string; channel: string; thread?: string; state: 'attempted' | 'sent'; expiresAt: number; ts?: string }
interface SendStore { version: 1; messages: Record<string, SendReceipt> }
export interface SlackDelivery { status: 'sent' | 'duplicate' | 'uncertain' | 'refused'; reason: string; ts?: string }
export interface SlackDeliveryPolicy { config: SlackBridgeConfig; teamIdentities: readonly TeamIdentity[]; confirmedByMason: boolean }
function readSendStore(path: string): SendStore {
  if (!existsSync(path)) return { version: 1, messages: {} };
  const read = readPrivateFileCapped(path, MAX_REPLY_BYTES);
  if (!read || read.truncated) throw new Error('slack-state-unavailable');
  const data: unknown = JSON.parse(read.text);
  if (!record(data) || data.version !== 1 || !record(data.messages) || Object.keys(data.messages).length > 1024) throw new Error('slack-state-invalid');
  for (const [id, value] of Object.entries(data.messages)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !record(value) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) ||
        typeof value.clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.clientId) || !isSlackChannelId(value.channel) ||
        !['attempted', 'sent'].includes(String(value.state)) || (value.state === 'sent' && !isSlackTs(value.ts)) ||
        !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 0 ||
        (value.thread !== undefined && !isSlackTs(value.thread))) throw new Error('slack-state-invalid');
  }
  return data as unknown as SendStore;
}

/** Persist intent BEFORE the single post. An ambiguous post is only reconciled, never replayed. */
export async function deliverSlackEnvelope(envelope: BusEnvelope, input: {
  config: SlackBridgeConfig; teamIdentities: readonly TeamIdentity[]; confirmedByMason: boolean;
  call: SlackCall; stateRoot?: string;
  readPolicy?: () => SlackDeliveryPolicy | undefined;
  signal?: AbortSignal;
}): Promise<SlackDelivery> {
  if (input.signal?.aborted) return { status: 'refused', reason: 'session-expired' };
  const checked = validateBusEnvelope(envelope);
  if (!checked.ok) return { status: 'refused', reason: 'invalid-envelope' };
  const planned = slackOutboundPlan(checked.value, input.config);
  if (!planned.ok) return { status: 'refused', reason: planned.reason };
  const root = input.stateRoot ?? join(ashlrHome(), 'fleet', 'slack-transport');
  let lock: ReturnType<typeof acquireLocalStoreLockWithOutcome>['lock'] = null;
  try {
    ensurePrivateDirectory(root);
    const stat = lstatSync(root);
    if ((stat.mode & 0o077) !== 0) throw new Error('slack-state-not-private');
    const acquired = acquireLocalStoreLockWithOutcome(join(root, 'send.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') return { status: 'refused', reason: 'delivery-claimed' };
    lock = acquired.lock;
    const path = join(root, 'messages.json'), store = readSendStore(path);
    // A terminal receipt outlives the original bus TTL. Uncertain intents are
    // retained until reconciled; pruning them could turn a timeout into a resend.
    for (const [id, receipt] of Object.entries(store.messages)) {
      if (receipt.state === 'sent' && receipt.expiresAt < Date.now()) delete store.messages[id];
    }
    const key = hash(checked.value.id), digest = hash(checked.json);
    const previous = store.messages[key];
    if (previous && previous.digest !== digest) return { status: 'refused', reason: 'message-identity-conflict' };
    await verifySlackIdentity(input.call, input.config);
    if (previous?.state === 'sent') return { status: 'duplicate', reason: 'delivery-proved', ts: previous.ts };
    if (previous) {
      const result = await input.call(previous.thread ? 'conversations.replies' : 'conversations.history', {
        channel: previous.channel, ...(previous.thread ? { ts: previous.thread } : {}), limit: 100,
      });
      if (!Array.isArray(result.messages)) throw new Error('slack-history-invalid');
      const matches = result.messages.filter(value => record(value) && value.client_msg_id === previous.clientId && value.user === input.config.ownUserId &&
        (!previous.thread || value.thread_ts === previous.thread) && isSlackTs(value.ts));
      if (matches.length !== 1) return { status: 'uncertain', reason: 'delivery-needs-reconciliation' };
      previous.state = 'sent'; previous.ts = (matches[0] as RecordValue).ts as string;
      writePrivateFileAtomic(path, JSON.stringify(store));
      return { status: 'sent', reason: 'delivery-reconciled', ts: previous.ts };
    }
    if (Object.keys(store.messages).length >= 1024) return { status: 'refused', reason: 'delivery-store-full' };
    const audience = await observeSlackAudience(input.call, planned.plan.channel);
    // Membership observation can take time. Revocations must win over its old policy snapshot.
    const current = input.readPolicy ? input.readPolicy() : input;
    if (!current || JSON.stringify(current.config) !== JSON.stringify(input.config) || input.signal?.aborted) return { status: 'refused', reason: 'policy-changed-or-session-expired' };
    const verdict = evaluateSlackAudience(current.config, current.teamIdentities, planned.plan.channel, audience);
    if (verdict.status !== 'postable') return { status: 'refused', reason: verdict.reason ?? 'audience-unproved' };
    const policy = slackSendDecision({ recipients: audience.members.filter(member => member.id !== input.config.ownUserId).map(member => member.id),
      teamIdentities: current.teamIdentities, external: verdict.external, confirmedByMason: current.confirmedByMason });
    if (policy.status !== 'sent') return { status: 'refused', reason: 'communication-not-approved' };
    const expiresAt = Date.now() + checked.value.ttl;
    if (!Number.isSafeInteger(expiresAt)) return { status: 'refused', reason: 'invalid-message-lifetime' };
    const receipt: SendReceipt = { digest, clientId: randomUUID(), channel: planned.plan.channel, state: 'attempted', expiresAt, ...(planned.plan.threadTs ? { thread: planned.plan.threadTs } : {}) };
    store.messages[key] = receipt;
    writePrivateFileAtomic(path, JSON.stringify(store));
    const result = await input.call('chat.postMessage', { channel: receipt.channel, text: planned.plan.text, client_msg_id: receipt.clientId,
      ...(receipt.thread ? { thread_ts: receipt.thread } : {}), unfurl_links: false, unfurl_media: false });
    if (result.channel !== receipt.channel || !isSlackTs(result.ts)) return { status: 'uncertain', reason: 'delivery-response-unproved' };
    receipt.state = 'sent'; receipt.ts = result.ts;
    writePrivateFileAtomic(path, JSON.stringify(store));
    return { status: 'sent', reason: 'delivery-proved', ts: receipt.ts };
  } catch { return { status: 'uncertain', reason: 'transport-or-storage-unavailable' }; }
  finally { releaseLocalStoreLock(lock); }
}

/** Acknowledge only durable append/duplicate or a deliberate policy rejection. */
export function receiveSlackSocketEnvelope(raw: unknown, ctx: SlackIngestContext, ack: (id: string) => void): boolean {
  const result = ingestSlackSocketMessage(raw, ctx);
  if (!result.envelopeId || result.envelopeId === 'unknown' || result.bus === 'failed') return false;
  ack(result.envelopeId);
  return true;
}

export interface SlackSocketSession {
  readonly readyState?: number;
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}
/** The ephemeral URL remains in memory. No cookies, public ingress, or secret-bearing receipts. */
export async function openSlackSocket(input: {
  call: SlackCall; config: SlackBridgeConfig; ingest: SlackIngestContext;
  connect: (url: string) => SlackSocketSession;
  signal?: AbortSignal;
  readIngest?: () => SlackIngestContext | undefined;
  owner?: (envelope: BusEnvelope) => Promise<{ owned: boolean; durable: boolean }>;
}): Promise<SlackSocketSession> {
  if (input.signal?.aborted) throw new Error('slack-session-expired');
  await verifySlackIdentity(input.call, input.config);
  const result = await input.call('apps.connections.open', {}, 'app');
  if (typeof result.url !== 'string') throw new Error('slack-socket-url-invalid');
  const url = new URL(result.url);
  if (url.protocol !== 'wss:' || !(url.hostname === 'wss-primary.slack.com' || url.hostname.endsWith('.slack.com')) || url.username || url.password) throw new Error('slack-socket-url-invalid');
  if (input.signal?.aborted) throw new Error('slack-session-expired');
  const socket = input.connect(result.url);
  input.signal?.addEventListener('abort', () => socket.close(), { once: true });
  socket.addEventListener('message', event => {
    if (input.signal?.aborted) return;
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_REPLY_BYTES) return;
    try {
      const raw: unknown = JSON.parse(event.data);
      if (record(raw) && raw.type === 'disconnect') { socket.close(); return; }
      const ctx = input.readIngest ? input.readIngest() : input.ingest;
      if (!ctx) return;
      const ack = (id: string): void => { if (!input.signal?.aborted) socket.send(JSON.stringify({ envelope_id: id })); };
      if (input.owner) {
        // Owner input is written once by the existing Leader network, rather
        // than first appending a competing raw peer envelope to the bus.
        const unwrapped = unwrapSlackSocketEnvelope(raw);
        const decision = 'event' in unwrapped ? slackEventToBus(unwrapped.event, ctx) : null;
        if (decision?.status === 'ingest') {
          void input.owner(decision.envelope).then(result => {
            if (result.owned) { if (result.durable && 'envelopeId' in unwrapped && unwrapped.envelopeId !== 'unknown') ack(unwrapped.envelopeId); }
            else receiveSlackSocketEnvelope(raw, ctx, ack);
          }).catch(() => {});
          return;
        }
      }
      receiveSlackSocketEnvelope(raw, ctx, ack);
    } catch { /* No acknowledgement after an unproved append; Slack can redeliver. */ }
  });
  if (socket.readyState !== 1) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('slack-socket-timeout')); }, 15_000);
      input.signal?.addEventListener('abort', () => { clearTimeout(timer); socket.close(); reject(new Error('slack-session-expired')); }, { once: true });
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('slack-socket-unavailable')); });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('slack-socket-unavailable')); });
    });
  }
  return socket;
}
