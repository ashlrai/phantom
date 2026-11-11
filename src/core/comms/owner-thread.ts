/**
 * Canonical owner thread. Every allowed inbound message lands in one ordered
 * record with its channel, sender and timestamp. Leader replies fan out to
 * the channel the owner used and to the desktop thread. Idempotency keys
 * make retries one message and one send per destination.
 *
 * iMessage bodies stay in this private file. Their bus mirror is redacted.
 * KILL and the comms pause halt every adapter before a transport is called.
 */
import { teammateReplyGapFromInbox, type TeammateReplyGap } from './teammate-reply-gap.js';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, unlinkSync } from 'node:fs';
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
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import {
  OWNER_THREAD_CLAIM_KEY,
  OWNER_THREAD_ID,
  createLeaderMailbox,
  OWNER_CHANNELS,
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
  base?: number;
  archivedKeys?: string[];
}

export interface OwnerThreadOptions {
  runsDir: string;
  capacity?: { messages: number; bytes: number };
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
  /** Additive: how long teammate texts have waited for a reply (metadata only). */
  replyGap: TeammateReplyGap[];
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
  const base = parsed.base ?? 0;
  if (!Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(base + parsed.messages.length) ||
      (parsed.archivedKeys !== undefined && (!Array.isArray(parsed.archivedKeys) || parsed.archivedKeys.length > 5000 ||
        parsed.archivedKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{16}$/.test(key))))) {
    throw new Error('Owner thread unavailable');
  }
  parsed.messages.forEach((message, index) => {
    if (!validMessage(message, base + index + 1)) throw new Error('Owner thread unavailable');
  });
  return parsed;
}

function capacity(options: OwnerThreadOptions): { messages: number; bytes: number } {
  const value = options.capacity;
  if (!value) return { messages: MAX_MESSAGES, bytes: MAX_BYTES };
  if (!Number.isSafeInteger(value.messages) || value.messages < 2 || value.messages > MAX_MESSAGES ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 2 || value.bytes > MAX_BYTES) throw new Error('Invalid owner thread capacity');
  return value;
}

function keyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function rotate(options: OwnerThreadOptions, state: ThreadState): void {
  const cap = capacity(options);
  const size = () => Buffer.byteLength(JSON.stringify(state));
  if (state.messages.length <= cap.messages && size() <= cap.bytes) return;
  const archived: OwnerThreadMessage[] = [];
  while (state.messages.length > Math.floor(cap.messages / 2) || size() > Math.floor(cap.bytes / 2)) {
    const message = state.messages.shift();
    if (!message) throw new Error('Owner thread full');
    archived.push(message);
    state.base = (state.base ?? 0) + 1;
    state.archivedKeys = [...(state.archivedKeys ?? []), keyDigest(message.idempotencyKey)].slice(-5000);
    if (message.direction === 'outbound') {
      for (const key of Object.keys(state.deliveries)) {
        if (key.slice(0, key.lastIndexOf(':')) === message.idempotencyKey) delete state.deliveries[key];
      }
    }
  }
  const directory = threadDir(options);
  const target = join(directory, `owner-thread-archive-${archived[0]!.seq}-${archived[archived.length - 1]!.seq}.json`);
  const text = JSON.stringify({ v: 1, threadId: OWNER_THREAD_ID, messages: archived });
  try {
    lstatSync(target);
    const existing = readStableRegularFile(target, { anchorPath: directory, maxFileBytes: MAX_BYTES * 2, remainingBytes: MAX_BYTES * 2 });
    if (!existing.ok || existing.text !== text) throw new Error('Owner thread archive conflict');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staged = join(directory, `.${randomUUID()}.archive`);
  writePrivateFileAtomically(join(directory, `.${randomUUID()}.tmp`), staged, text, {
    anchorPath: directory, label: 'Owner thread archive',
  });
  try { linkSync(staged, target); fsyncDirectory(directory); } finally { unlinkSync(staged); }
}

function writeState(options: OwnerThreadOptions, state: ThreadState): void {
  const directory = threadDir(options);
  const text = JSON.stringify(state);
  const cap = capacity(options);
  if (state.messages.length > cap.messages || Buffer.byteLength(text) > cap.bytes) throw new Error('Owner thread full');
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
    rotate(options, state);
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
  const seq = (state.base ?? 0) + state.messages.length + 1;
  if (!Number.isSafeInteger(seq)) throw new Error('Owner thread full');
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
      if (state.archivedKeys?.includes(keyDigest(input.idempotencyKey))) return { status: 'duplicate' as const, idempotencyKey: input.idempotencyKey };
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
      if (input.idempotencyKey && state.archivedKeys?.includes(keyDigest(input.idempotencyKey))) {
        return { status: 'duplicate' as const, idempotencyKey: input.idempotencyKey };
      }
      const inbound = input.replyTo
        ? state.messages.find(message => message.direction === 'inbound' && message.idempotencyKey === input.replyTo)
        : [...state.messages].reverse().find(message => message.direction === 'inbound');
      if (!inbound) return { status: 'refused' as const, reason: 'No owner message to answer.' };
      const key = replyKey(input, inbound.idempotencyKey, text);
      if (!KEY.test(key)) return { status: 'refused' as const, reason: 'Reply identity is invalid.' };
      if (state.archivedKeys?.includes(keyDigest(key))) return { status: 'duplicate' as const, idempotencyKey: key };
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

/**
 * Record a proactive Leader post (brief, recap, ping) as one outbound desktop
 * line so the owner thread shows what was sent elsewhere. Calls no transport:
 * nothing leaves the machine. Same halt, secret and idempotency rules as replies.
 */
export async function postOwnerNotice(input: { text: string; idempotencyKey: string }, options: OwnerThreadOptions): Promise<OwnerThreadResult> {
  if (halted(options) || paused(options)) return { status: 'halted', reason: 'Adapters are halted.' };
  const text = cleanText(input.text);
  if (!text || typeof input.idempotencyKey !== 'string' || !KEY.test(input.idempotencyKey)) {
    return { status: 'refused', reason: 'Notice is not recordable.' };
  }
  const key = input.idempotencyKey;
  try {
    return await transaction(options, async state => {
      const prior = state.messages.find(message => message.idempotencyKey === key);
      if (prior) return { status: 'duplicate' as const, seq: prior.seq, idempotencyKey: key };
      if (state.archivedKeys?.includes(keyDigest(key))) return { status: 'duplicate' as const, idempotencyKey: key };
      const stored = appendMessage(state, {
        idempotencyKey: key, channel: 'desktop', senderId: 'leader', direction: 'outbound',
        at: new Date(clock(options)).toISOString(), text, fanout: ['desktop'],
      });
      mirror(options, stored);
      return { status: 'accepted' as const, seq: stored.seq, idempotencyKey: key };
    });
  } catch {
    return { status: 'unavailable', reason: 'Owner thread is unavailable.' };
  }
}

export const OWNER_HELLO_TEXT ='Leader is live here, reply to talk to me.';

export interface OwnerHelloResult {
  status: 'sent' | 'partial' | 'refused' | 'duplicate' | 'halted' | 'unavailable';
  deliveries: Array<{ channel: OwnerChannel; status: 'sent' | 'duplicate' | 'refused' | 'disabled' | 'halted'; reason: string }>;
}

/**
 * Tell the owner, once per enabled channel, that the channel is live. Same gate
 * as `sendOwnerReply`: only the confirmed owner, never while halted or paused.
 * A recorded receipt makes every later call a no-op for that channel.
 */
export async function sendOwnerHello(options: OwnerThreadOptions): Promise<OwnerHelloResult> {
  if (halted(options) || paused(options)) return { status: 'halted', deliveries: [] };
  try {
    return await transaction(options, async state => {
      const deliveries: OwnerHelloResult['deliveries'] = [];
      for (const channel of OWNER_CHANNELS) {
        if (channel === 'desktop') continue;
        const key = `hello-${channel}-v1`;
        const receiptKey = `${key}:${channel}`;
        if (state.deliveries[receiptKey] === 'sent' || state.archivedKeys?.includes(keyDigest(key))) {
          deliveries.push({ channel, status: 'duplicate', reason: 'Hello already sent.' });
          continue;
        }
        const ownerId = options.settings.owners[channel];
        const gate = adapterStatus(channel, options.settings, false, false);
        if (!gate.enabled || !ownerId) {
          deliveries.push({ channel, status: 'disabled', reason: gate.reason });
          continue;
        }
        const transport = options.transports?.[channel];
        if (!transport) {
          deliveries.push({ channel, status: 'disabled', reason: 'No transport is attached for this channel.' });
          continue;
        }
        const policy = checkSendPolicy({
          channel: ownerChannelToBus(channel), recipients: [ownerId], teamIdentities: options.settings.team,
          external: false, confirmedByMason: options.settings.confirmed,
        });
        if (policy.status !== 'sent') {
          deliveries.push({ channel, status: 'refused', reason: 'Hello only goes to the confirmed owner.' });
          continue;
        }
        const kill = halted(options);
        const hold = paused(options);
        if (kill || hold) {
          deliveries.push({ channel, status: 'halted', reason: 'Adapters are halted.' });
          continue;
        }
        let result: { status: 'sent' | 'duplicate' | 'refused' };
        try { result = await transport.deliver({ idempotencyKey: receiptKey, text: OWNER_HELLO_TEXT, ownerId }); }
        catch { result = { status: 'refused' }; }
        if (result.status !== 'sent' && result.status !== 'duplicate') {
          deliveries.push({ channel, status: 'refused', reason: 'Channel transport refused the hello.' });
          continue;
        }
        state.deliveries[receiptKey] = 'sent';
        mirror(options, appendMessage(state, {
          idempotencyKey: key, channel, senderId: 'leader', direction: 'outbound',
          at: new Date(clock(options)).toISOString(), text: OWNER_HELLO_TEXT, fanout: [channel],
        }));
        deliveries.push({ channel, status: result.status, reason: 'Delivered to the owner.' });
      }
      // Disabled channels are skipped, not failures. Only a refusal makes the run partial.
      const sent = deliveries.some(row => row.status === 'sent');
      const failed = deliveries.some(row => row.status === 'refused' || row.status === 'halted');
      const status: OwnerHelloResult['status'] = sent
        ? (failed ? 'partial' : 'sent')
        : !failed && deliveries.some(row => row.status === 'duplicate') ? 'duplicate' : 'refused';
      return { status, deliveries };
    });
  } catch {
    return { status: 'unavailable', deliveries: [] };
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
  try { const state = readState(options); messages = (state.base ?? 0) + state.messages.length; } catch { messages = 0; }
  return {
    schema: 'comms.owner-thread.status.v1',
    claimKey: OWNER_THREAD_CLAIM_KEY,
    threadId: OWNER_THREAD_ID,
    kill, paused: hold, messages,
    adapters: listAdapterStatus(options.settings, kill, hold),
    replyGap: teammateReplyGapFromInbox(clock(options), options.runsDir),
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
