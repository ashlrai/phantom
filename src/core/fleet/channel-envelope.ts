/** Shared inbound boundary. Adapters authenticate first and map channel identities
 * to one canonical sender ID; an asserted ID in a message body is never identity.
 * Default inbox receipts survive receiver restarts in the shared runs context.
 */
import { CHANNEL_RECEIPT_LIMIT, createLocalChannelDedupeStore, type ChannelDedupeStore } from './channel-dedupe-store.js';
import { createHash } from 'node:crypto';
import { appendInboxEntry, INBOX_MAX_CHARS, type InboxAppendOptions, type InboxAppendResult } from './mason-inbox.js';
import { scrubSecrets } from '../util/scrub.js';

export const INBOUND_CHANNELS = ['email', 'telegram', 'mobile', 'desktop', 'page', 'cli'] as const;
export type InboundChannel = typeof INBOUND_CHANNELS[number];
export const CHANNEL_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export interface ChannelMessage {
  channel: InboundChannel;
  /** Authenticated canonical identity supplied by the trusted adapter. No credentials. */
  verifiedSenderId: string;
  body: string;
}
export interface ChannelEnvelope extends ChannelMessage {
  receivedAt: string;
  dedupeKey: string;
}
export interface ChannelAck {
  channel: InboundChannel;
  dedupeKey: string;
  status: 'accepted' | 'duplicate';
}
export type ChannelReceiveResult =
  | { ok: true; envelope: ChannelEnvelope; ack: ChannelAck }
  | { ok: false; reason: 'dedupe-store-unavailable' | 'sender-not-allowed' | 'invalid' | 'full' | 'write-failed' | Exclude<InboxAppendResult, { ok: true }>['reason'] };

export interface ChannelReceiverOptions extends Pick<InboxAppendOptions, 'runsDir' | 'now'> {
  allowedSenderIds: ReadonlySet<string>;
  /** Custom sinks without runsDir remain memory-only unless a store is supplied.
   * Default inbox sinks use a local receipt store under runsDir. */
  receiptStore?: ChannelDedupeStore;
  /** Optional sink for another shared context. Must report success only after persistence. */
  write?: (envelope: ChannelEnvelope) => Promise<InboxAppendResult>;
  /** Best-effort transport, not durable delivery. Calls are serialized; do not await
   * another receive on this receiver from the callback. Receives only a detached ack. */
  acknowledge?: (ack: ChannelAck) => Promise<void>;
}

/** Rolling window from first successful receipt, including across clock bucket
 * boundaries. Retains only hashes/times, never credentials or message bodies.
 * Failed writes do not reserve a key. Capacity refuses rather than evicting keys.
 */
export function createChannelReceiver(options: ChannelReceiverOptions): (input: ChannelMessage) => Promise<ChannelReceiveResult> {
  const allowed = new Set(options.allowedSenderIds);
  const seen = new Map<string, { at: number; key: string }>();
  const store = options.receiptStore ?? (options.write && options.runsDir === undefined
    ? undefined : createLocalChannelDedupeStore(options.runsDir));
  let tail = Promise.resolve();
  let lastTime = 0;
  async function success(envelope: ChannelEnvelope, status: ChannelAck['status']): Promise<ChannelReceiveResult> {
    const ack: ChannelAck = { channel: envelope.channel, dedupeKey: envelope.dedupeKey, status };
    try { await options.acknowledge?.({ ...ack }); } catch { /* Transport is best-effort. */ }
    return { ok: true, envelope, ack };
  }
  async function receive(input: ChannelMessage): Promise<ChannelReceiveResult> {
    if (typeof input?.verifiedSenderId !== 'string' || !allowed.has(input.verifiedSenderId)) {
      return { ok: false, reason: 'sender-not-allowed' };
    }
    if (!INBOUND_CHANNELS.includes(input.channel) || typeof input.body !== 'string' ||
        !input.verifiedSenderId.trim() || input.verifiedSenderId.length > 128 ||
        scrubSecrets(input.verifiedSenderId) !== input.verifiedSenderId) return { ok: false, reason: 'invalid' };
    if (input.body.length > INBOX_MAX_CHARS) return { ok: false, reason: 'too-long' };
    // Check before normalization too: normalization must never hide a credential.
    if (scrubSecrets(input.body) !== input.body) return { ok: false, reason: 'secret-shaped' };
    const body = input.body.normalize('NFC').replace(/\r\n?/g, '\n').trim();
    if (!body) return { ok: false, reason: 'empty' };
    if (scrubSecrets(body) !== body) return { ok: false, reason: 'secret-shaped' };
    const now = (options.now ?? (() => new Date()))().getTime();
    if (!Number.isSafeInteger(now) || now < lastTime || now < 0) return { ok: false, reason: 'invalid' };
    lastTime = now;
    const work = async (receipts: typeof seen, commit: () => void | Promise<void>): Promise<
      { envelope: ChannelEnvelope; status: ChannelAck['status'] } | Exclude<ChannelReceiveResult, { ok: true }>
    > => {
      for (const [hash, receipt] of receipts) {
        if (now - receipt.at >= CHANNEL_DEDUPE_WINDOW_MS) receipts.delete(hash);
      }
      const hash = createHash('sha256').update(JSON.stringify([input.verifiedSenderId, body])).digest('hex');
      const previous = receipts.get(hash);
      const dedupeKey = previous?.key ?? createHash('sha256').update(JSON.stringify([hash, now])).digest('hex');
      const envelope: ChannelEnvelope = {
        channel: input.channel, verifiedSenderId: input.verifiedSenderId,
        receivedAt: new Date(now).toISOString(), body, dedupeKey,
      };
      if (previous) return { envelope, status: 'duplicate' };
      if (receipts.size >= CHANNEL_RECEIPT_LIMIT) return { ok: false, reason: 'full' };
      try {
        const result = options.write
          ? await options.write({ ...envelope })
          : await appendInboxEntry(body, { runsDir: options.runsDir, now: () => new Date(now), source: input.channel });
        if (!result.ok) return { ok: false, reason: result.reason };
      } catch { return { ok: false, reason: 'write-failed' }; }
      receipts.set(hash, { at: now, key: dedupeKey });
      await commit();
      return { envelope, status: 'accepted' };
    };
    try {
      const result = store ? await store.transaction(work) : await work(seen, () => {});
      return 'envelope' in result ? success(result.envelope, result.status) : result;
    } catch { return { ok: false, reason: 'dedupe-store-unavailable' }; }
  }
  return (input) => {
    // Snapshot before queuing: callers cannot change identity/body while waiting.
    const snapshot = { channel: input?.channel, verifiedSenderId: input?.verifiedSenderId, body: input?.body };
    const result = tail.then(() => receive(snapshot));
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
