import { createHash } from 'node:crypto';
import type { BusEnvelope } from './bus-envelope.js';
import { CHANNEL_RECEIPT_LIMIT, createLocalChannelDedupeStore, type ChannelDedupeStore } from './channel-dedupe-store.js';
import { createChannelReceiver, type ChannelReceiveResult } from './channel-envelope.js';
import { INBOX_MAX_CHARS, type InboxAppendOptions } from './mason-inbox.js';

export const LEADERS_ADDRESS = 'leaders';
const CONSOLE_SENDER = 'mason';

export function isLeaderAddressedFromConsole(envelope: BusEnvelope): boolean {
  return envelope.from === CONSOLE_SENDER && envelope.to === LEADERS_ADDRESS;
}

export function inboxTextFor(envelope: BusEnvelope): string | null {
  const body = envelope.body;
  const text = typeof body === 'string' ? body :
    body !== null && typeof body === 'object' && !Array.isArray(body) && typeof body.text === 'string' ? body.text : null;
  return text === null ? null : `[bus→leaders] ${text}`.slice(0, INBOX_MAX_CHARS);
}

/** Adapt the channel store's sender/body key to a durable, namespaced bus ID.
 * The channel receiver normally expires receipts after ten minutes. Bus IDs
 * remain deduplicated for as long as their receipt is retained. */
function busReceiptStore(id: string, body: string, runsDir: string | undefined, at: number): ChannelDedupeStore {
  const store = createLocalChannelDedupeStore(runsDir);
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const busKey = hash(['bus-leader-inbox', id]);
  const channelKey = hash([CONSOLE_SENDER, body.normalize('NFC').replace(/\r\n?/g, '\n').trim()]);
  return {
    transaction: (work) => store.transaction(async (receipts, commit) => {
      const prior = receipts.get(busKey);
      const local = new Map(prior ? [[channelKey, { ...prior, at }]] : []);
      if (!prior && receipts.size >= CHANNEL_RECEIPT_LIMIT) throw new Error('Channel receipts full');
      return work(local, async () => {
        const receipt = local.get(channelKey);
        if (receipt) receipts.set(busKey, receipt);
        await commit();
      });
    }),
  };
}

/** The bus is already durable; never publish the resulting channel receipt back. */
export async function mirrorLeaderPostToInbox(
  envelope: BusEnvelope, opts: Pick<InboxAppendOptions, 'runsDir' | 'now'> = {},
): Promise<ChannelReceiveResult | null> {
  if (!isLeaderAddressedFromConsole(envelope)) return null;
  const body = inboxTextFor(envelope);
  if (body === null) return null;
  const now = (opts.now ?? (() => new Date()))();
  const receive = createChannelReceiver({
    allowedSenderIds: new Set([CONSOLE_SENDER]), runsDir: opts.runsDir, now: () => now,
    receiptStore: busReceiptStore(envelope.id, body, opts.runsDir, now.getTime()), publish: null,
  });
  const result = await receive({ channel: 'desktop', verifiedSenderId: CONSOLE_SENDER, body });
  return result.ok ? { ...result, envelope: { ...result.envelope, dedupeKey: envelope.id },
    ack: { ...result.ack, dedupeKey: envelope.id } } : result;
}
