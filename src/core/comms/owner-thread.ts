/**
 * Canonical owner thread. Every allowed inbound message lands in one ordered
 * record with its channel, sender and timestamp. Leader replies fan out to
 * the channel the owner used and to the desktop thread. Idempotency keys
 * make retries one message and one send per destination.
 *
 * iMessage bodies stay in this private file. Their bus mirror is redacted.
 * KILL and the comms pause halt every adapter before a transport is called.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { checkSendPolicy } from '../agents/channel-policy.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import { INBOX_MAX_CHARS } from '../fleet/mason-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import type { BusChannel, BusEnvelope } from '../fleet/bus-envelope.js';
import { isPaused } from './pause.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { scrubSecrets } from '../util/scrub.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import {
  OWNER_THREAD_CLAIM_KEY,
  OWNER_THREAD_ID,
  createLeaderMailbox,
  isOwnerChannel,
  ownerChannelToBus,
  type LeaderMailbox,
  type OwnerChannel,
} from './leader-mailbox.js';
import {
  adapterStatus,
  busIdentity,
  fanoutChannels,
  listAdapterStatus,
  ownerAllowed,
  type OwnerAdapterStatus,
  type OwnerChannelTransport,
  type OwnerThreadSettings,
} from './owner-channel.js';

const MAX_MESSAGES = 2_000;
const MAX_BYTES = 1_048_576;
const KEY = /^[A-Za-z0-9._:-]{8,80}$/;

export interface OwnerThreadMessage {
  seq: number;
  id: string;
  idempotencyKey: string;
  channel: OwnerChannel;
  senderId: string;
  direction: 'inbound' | 'outbound';
  at: string;
  text: string;
  replyTo?: string;
  fanout?: OwnerChannel[];
  channelRef?: string;
}

interface ThreadState {
  v: 1;
  threadId: typeof OWNER_THREAD_ID;
  messages: OwnerThreadMessage[];
  deliveries: Record<string, 'sent'>;
}

export interface OwnerThreadOptions {
  runsDir: string;
  busRoot?: string;
  now?: () => number;
  settings: OwnerThreadSettings;
  transports?: Partial<Record<OwnerChannel, OwnerChannelTransport>>;
  mailbox?: LeaderMailbox;
  halted?: boolean;
  paused?: boolean;
}

export interface OwnerInboundInput {
  channel: OwnerChannel;
  senderId: string;
  text: string;
  idempotencyKey: string;
  at: number;
  channelRef?: string;
}

export interface OwnerReplyInput {
  text: string;
  replyTo?: string;
  idempotencyKey?: string;
}

export interface OwnerThreadResult {
  status: 'accepted' | 'duplicate' | 'refused' | 'halted' | 'unavailable' | 'partial' | 'sent';
  reason?: string;
  seq?: number;
  idempotencyKey?: string;
  deliveries?: Array<{ channel: OwnerChannel; status: 'sent' | 'duplicate' | 'refused' | 'disabled' | 'halted'; reason: string }>;
}

export interface OwnerCommsStatus {
  schema: 'comms.owner-thread.status.v1';
  claimKey: typeof OWNER_THREAD_CLAIM_KEY;
  threadId: typeof OWNER_THREAD_ID;
  kill: boolean;
  paused: boolean;
  messages: number;
  adapters: OwnerAdapterStatus[];
}

function clock(options: OwnerThreadOptions): number {
  const value = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid owner-thread clock');
  return value;
}

function safeRef(value: string | undefined): boolean {
  return value === undefined || (value.length > 0 && value.length <= 256 && Array.from(value).every(character => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }));
}

function cleanText(text: string): string | null {
  if (typeof text !== 'string') return null;
  const value = text.replace(/\r\n?/g, '\n').trim();
  if (!value || value.length > INBOX_MAX_CHARS || scrubSecrets(value) !== value) return null;
  return value;
}

/** A captured `false` does not hide a KILL or pause that appears later. */
function halted(options: OwnerThreadOptions): boolean {
  return options.halted === true || killSwitchOn();
}

function paused(options: OwnerThreadOptions): boolean {
  return options.paused === true || isPaused();
}

function threadDir(options: OwnerThreadOptions): string {
  return join(options.runsDir, 'leader');
}

function blank(): ThreadState {
  return { v: 1, threadId: OWNER_THREAD_ID, messages: [], deliveries: {} };
}

function validMessage(value: OwnerThreadMessage, seq: number): boolean {
  return value.seq === seq && KEY.test(value.idempotencyKey) && isOwnerChannel(value.channel) &&
    (value.direction === 'inbound' || value.direction === 'outbound') &&
    typeof value.at === 'string' && typeof value.text === 'string' && typeof value.senderId === 'string';
}

function readState(options: OwnerThreadOptions): ThreadState {
  const file = join(threadDir(options), 'owner-thread.json');
  try { lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return blank();
    throw new Error('Owner thread unavailable');
  }
  const result = readStableRegularFile(file, { anchorPath: threadDir(options), maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!result.ok) throw new Error('Owner thread unavailable');
  const parsed = JSON.parse(result.text) as ThreadState;
  if (parsed.v !== 1 || parsed.threadId !== OWNER_THREAD_ID || !Array.isArray(parsed.messages) ||
      !parsed.deliveries || typeof parsed.deliveries !== 'object' || Array.isArray(parsed.deliveries)) {
    throw new Error('Owner thread unavailable');
  }
  parsed.messages.forEach((message, index) => {
    if (!validMessage(message, index + 1)) throw new Error('Owner thread unavailable');
  });
  return parsed;
}

function writeState(options: OwnerThreadOptions, state: ThreadState): void {
  const directory = threadDir(options);
  const text = JSON.stringify(state);
  if (state.messages.length > MAX_MESSAGES || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Owner thread full');
  writePrivateFileAtomically(join(directory, `.${randomUUID()}.tmp`), join(directory, 'owner-thread.json'), text, {
    anchorPath: directory, label: 'Owner thread',
  });
}

async function transaction<T>(options: OwnerThreadOptions, work: (state: ThreadState) => Promise<T>): Promise<T> {
  const directory = threadDir(options);
  ensurePrivateDirectory(options.runsDir);
  ensurePrivateDirectory(directory);
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, 'owner-thread.lock'), 0, { anchorPath: directory });
  if (acquired.state !== 'acquired') throw new Error('Owner thread busy');
  try {
    const state = readState(options);
    const result = await work(state);
    writeState(options, state);
    return result;
  } finally {
    releaseLocalStoreLock(acquired.lock);
  }
}

function envelope(id: string, channel: BusChannel, direction: 'inbound' | 'outbound', text: string | null): BusEnvelope {
  return {
    id, from: direction === 'inbound' ? 'mason' : 'leader', to: direction === 'inbound' ? 'leader' : 'mason',
    priority: 'P0', ttl: CHANNEL_BUS_TTL_MS,
    body: text === null
      ? { kind: 'owner-thread', threadId: OWNER_THREAD_ID, channel, redacted: true }
      : { kind: 'owner-thread', threadId: OWNER_THREAD_ID, channel, text },
    channel, channel_ref: OWNER_THREAD_ID,
    sender: { agent_id: direction === 'inbound' ? 'mason' : 'leader', vendor: 'phantom', human: direction === 'inbound', team: true },
    external: false, origin_bridge: 'owner-thread',
  };
}

function mirror(options: OwnerThreadOptions, message: OwnerThreadMessage): void {
  const busChannel = ownerChannelToBus(message.channel);
  const text = message.channel === 'imessage' ? null : message.text;
  const post = appendBusInbox(envelope(`ot-${message.idempotencyKey}`, busChannel, message.direction, text), {
    root: options.busRoot, now: options.now,
  });
  if (post.status !== 'posted' && post.status !== 'duplicate') throw new Error('Owner thread bus mirror unavailable');
}

function appendMessage(state: ThreadState, message: Omit<OwnerThreadMessage, 'seq' | 'id'>): OwnerThreadMessage {
  const seq = state.messages.length + 1;
  const stored: OwnerThreadMessage = { ...message, seq, id: `m${seq}` };
  state.messages.push(stored);
  return stored;
}

function mailboxFor(options: OwnerThreadOptions): LeaderMailbox {
  return options.mailbox ?? createLeaderMailbox({ runsDir: options.runsDir, busRoot: options.busRoot, now: options.now });
}

export async function acceptOwnerInbound(input: OwnerInboundInput, options: OwnerThreadOptions): Promise<OwnerThreadResult> {
  if (halted(options) || paused(options)) return { status: 'halted', reason: 'Adapters are halted.' };
  const text = cleanText(input.text);
  if (!isOwnerChannel(input.channel) || !KEY.test(input.idempotencyKey) || !text || !safeRef(input.channelRef)) {
    return { status: 'refused', reason: 'Owner message is invalid.' };
  }
  const gate = adapterStatus(input.channel, options.settings, false, false);
  if (!gate.configured || !ownerAllowed(input.channel, input.senderId, options.settings)) {
    return { status: 'refused', reason: 'Sender is not the configured owner for that channel.' };
  }
  if (!Number.isSafeInteger(input.at) || input.at < 0) return { status: 'refused', reason: 'Owner message is invalid.' };
  try {
    return await transaction(options, async state => {
      const existing = state.messages.find(message => message.idempotencyKey === input.idempotencyKey);
      if (existing) return { status: 'duplicate' as const, seq: existing.seq, idempotencyKey: existing.idempotencyKey };
      const receipt = await mailboxFor(options).accept({
        channel: input.channel, senderId: input.senderId, text, idempotencyKey: input.idempotencyKey, receivedAt: input.at,
      });
      if (receipt.status !== 'accepted' && receipt.status !== 'duplicate') {
        return { status: receipt.status === 'unavailable' ? 'unavailable' as const : 'refused' as const, reason: receipt.reason };
      }
      const stored = appendMessage(state, {
        idempotencyKey: input.idempotencyKey, channel: input.channel, senderId: input.senderId,
        direction: 'inbound', at: new Date(input.at).toISOString(), text,
        ...(input.channelRef ? { channelRef: input.channelRef } : {}),
      });
      mirror(options, stored);
      return { status: 'accepted' as const, seq: stored.seq, idempotencyKey: stored.idempotencyKey };
    });
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'Owner thread is unavailable.' };
  }
}

function replyKey(input: OwnerReplyInput, replyTo: string, text: string): string {
  if (input.idempotencyKey) return input.idempotencyKey;
  const digest = createHash('sha256').update(JSON.stringify([replyTo, text])).digest('hex').slice(0, 16);
  return `reply-${digest}`;
}

export async function sendOwnerReply(input: OwnerReplyInput, options: OwnerThreadOptions): Promise<OwnerThreadResult> {
  if (halted(options) || paused(options)) return { status: 'halted', reason: 'Adapters are halted.' };
  const text = cleanText(input.text);
  if (!text) return { status: 'refused', reason: 'Reply text is not sendable.' };
  if (input.idempotencyKey !== undefined && !KEY.test(input.idempotencyKey)) {
    return { status: 'refused', reason: 'Reply identity is invalid.' };
  }
  try {
    return await transaction(options, async state => {
      const inbound = input.replyTo
        ? state.messages.find(message => message.direction === 'inbound' && message.idempotencyKey === input.replyTo)
        : [...state.messages].reverse().find(message => message.direction === 'inbound');
      if (!inbound) return { status: 'refused' as const, reason: 'No owner message to answer.' };
      const key = replyKey(input, inbound.idempotencyKey, text);
      if (!KEY.test(key)) return { status: 'refused' as const, reason: 'Reply identity is invalid.' };
      const prior = state.messages.find(message => message.direction === 'outbound' && message.idempotencyKey === key);
      if (prior && prior.text !== text) return { status: 'refused' as const, reason: 'A different reply already owns this identity.' };
      const destinations = fanoutChannels(inbound.channel);
      const deliveries: NonNullable<OwnerThreadResult['deliveries']> = [];
      for (const channel of destinations) {
        const receiptKey = `${key}:${channel}`;
        if (state.deliveries[receiptKey] === 'sent') {
          deliveries.push({ channel, status: 'duplicate', reason: 'Already delivered to the owner.' });
          continue;
        }
        const ownerId = options.settings.owners[channel];
        const gate = adapterStatus(channel, options.settings, false, false);
        if (!gate.configured || !ownerId) {
          deliveries.push({ channel, status: 'disabled', reason: gate.reason });
          continue;
        }
        const policy = checkSendPolicy({
          channel: ownerChannelToBus(channel),
          recipients: [ownerId],
          teamIdentities: options.settings.team,
          external: false,
          confirmedByMason: options.settings.confirmed,
        });
        if (policy.status !== 'sent') {
          deliveries.push({ channel, status: 'refused', reason: 'Replies only go to the confirmed owner.' });
          continue;
        }
        if (!options.settings.team.some(identity => identity.channel === busIdentity(channel, ownerId).channel && identity.id === ownerId)) {
          deliveries.push({ channel, status: 'refused', reason: 'Replies only go to the confirmed owner.' });
          continue;
        }
        const transport = options.transports?.[channel];
        if (!transport) {
          deliveries.push({ channel, status: 'disabled', reason: 'No transport is attached for this channel.' });
          continue;
        }
        const kill = halted(options);
        const hold = paused(options);
        const liveGate = adapterStatus(channel, options.settings, kill, hold);
        if (kill || hold || !liveGate.enabled) {
          deliveries.push({ channel, status: kill || hold ? 'halted' : 'disabled', reason: liveGate.reason });
          continue;
        }
        let result: { status: 'sent' | 'duplicate' | 'refused' };
        try {
          result = await transport.deliver({
            idempotencyKey: receiptKey, text, ownerId,
            ...(channel === inbound.channel && inbound.channelRef ? { channelRef: inbound.channelRef } : {}),
          });
        }
        catch { result = { status: 'refused' }; }
        if (result.status === 'sent' || result.status === 'duplicate') {
          state.deliveries[receiptKey] = 'sent';
          deliveries.push({ channel, status: result.status, reason: 'Delivered to the owner.' });
        } else {
          deliveries.push({ channel, status: 'refused', reason: 'Channel transport refused the owner reply.' });
        }
      }
      if (!prior) {
        const stored = appendMessage(state, {
          idempotencyKey: key, channel: inbound.channel, senderId: 'leader', direction: 'outbound',
          at: new Date(clock(options)).toISOString(), text, replyTo: inbound.idempotencyKey, fanout: destinations,
        });
        mirror(options, stored);
      }
      const sent = deliveries.some(row => row.status === 'sent' || row.status === 'duplicate');
      const complete = deliveries.every(row => row.status === 'sent' || row.status === 'duplicate');
      if (complete && deliveries.every(row => row.status === 'duplicate')) {
        return { status: 'duplicate' as const, idempotencyKey: key, deliveries };
      }
      return { status: complete ? 'sent' as const : sent ? 'partial' as const : 'refused' as const, idempotencyKey: key, deliveries };
    });
  } catch {
    return { status: 'unavailable', reason: 'Owner thread is unavailable.' };
  }
}

export function readOwnerThread(options: OwnerThreadOptions, limit = 200): { schema: 'comms.owner-thread.v1'; threadId: typeof OWNER_THREAD_ID; messages: OwnerThreadMessage[] } | { schema: 'comms.owner-thread.v1'; threadId: typeof OWNER_THREAD_ID; messages: []; unavailable: true } {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 200;
  try {
    const state = readState(options);
    return { schema: 'comms.owner-thread.v1', threadId: OWNER_THREAD_ID, messages: state.messages.slice(-cap) };
  } catch {
    return { schema: 'comms.owner-thread.v1', threadId: OWNER_THREAD_ID, messages: [], unavailable: true };
  }
}

export function readOwnerCommsStatus(options: OwnerThreadOptions): OwnerCommsStatus {
  const kill = halted(options);
  const hold = paused(options);
  let messages = 0;
  try { messages = readState(options).messages.length; } catch { messages = 0; }
  return {
    schema: 'comms.owner-thread.status.v1',
    claimKey: OWNER_THREAD_CLAIM_KEY,
    threadId: OWNER_THREAD_ID,
    kill, paused: hold, messages,
    adapters: listAdapterStatus(options.settings, kill, hold),
  };
}

/** Pull one configured adapter. Halted adapters do not call the transport. */
/** Best-effort copy of an authenticated receipt. Failures never change the caller's receipt. */
export async function noteOwnerReceipt(input: OwnerInboundInput, options: OwnerThreadOptions): Promise<void> {
  try {
    const mailbox = input.channel === 'imessage' ? options.mailbox : { accept: async () => ({ status: 'accepted' as const }) };
    await acceptOwnerInbound(input, { ...options, ...(mailbox ? { mailbox } : {}) });
  } catch { /* The existing leader receipt stays authoritative. */ }
}

export async function pullOwnerChannel(channel: OwnerChannel, options: OwnerThreadOptions): Promise<OwnerThreadResult[]> {
  if (halted(options) || paused(options)) return [{ status: 'halted', reason: 'Adapters are halted.' }];
  const gate = adapterStatus(channel, options.settings, halted(options), paused(options));
  if (!gate.enabled && !gate.configured) return [{ status: 'refused', reason: gate.reason }];
  const transport = options.transports?.[channel];
  if (!transport) return [{ status: 'refused', reason: 'No transport is attached for this channel.' }];
  if (halted(options) || paused(options)) return [{ status: 'halted', reason: 'Adapters are halted.' }];
  let batch: Awaited<ReturnType<OwnerChannelTransport['pull']>>;
  try { batch = await transport.pull(); } catch { return [{ status: 'unavailable', reason: 'Channel transport is unavailable.' }]; }
  const results: OwnerThreadResult[] = [];
  for (const item of batch) {
    results.push(await acceptOwnerInbound({ ...item, channel }, options));
  }
  return results;
}
