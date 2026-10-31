/** Mirrors accepted channel receipts onto the durable local agent bus, so
 * `phm comms bus read` and the fleet agent-bus API observe Mason's channel
 * interjections without tailing MASON-INBOX.md. Publishing is strictly best
 * effort: it can never change a receipt, its acknowledgement, or its dedupe
 * window, and it never throws. */
import { appendBusInbox } from './bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';
import type { ChannelEnvelope } from './channel-envelope.js';

export const CHANNEL_BUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export type ChannelPublishState = 'published' | 'skipped' | 'failed';
export interface ChannelBusPublishOptions { root?: string; now?: () => number }

/** One bus id per durable dedupe key keeps republication idempotent across
 * receiver restarts. Validation encodes the exact wire bytes, so an
 * interjection too large for one envelope is refused here — never truncated.
 * `now` is accepted for clock symmetry with `publishChannelEnvelope` and is
 * currently unused: the envelope carries only the receipt's own timestamp. */
export function buildChannelBusEnvelope(envelope: ChannelEnvelope, _now?: () => number): BusEnvelope | null {
  const candidate: BusEnvelope = {
    id: `mason-${envelope.channel}-${envelope.dedupeKey.slice(0, 16)}`,
    from: 'mason',
    to: 'leaders',
    priority: 'P0',
    ttl: CHANNEL_BUS_TTL_MS,
    body: {
      kind: 'interjection',
      channel: envelope.channel,
      text: envelope.body,
      receivedAt: envelope.receivedAt,
      dedupeKey: envelope.dedupeKey,
    },
  };
  return validateBusEnvelope(candidate).ok ? candidate : null;
}

/** Best-effort store append. `skipped` means the envelope was refused before
 * the store was touched (oversize); `failed` means the store rejected or could
 * not be reached. An already-present identical mirror still reads `published`. */
export async function publishChannelEnvelope(
  envelope: ChannelEnvelope,
  options: ChannelBusPublishOptions = {},
): Promise<ChannelPublishState> {
  try {
    const busEnvelope = buildChannelBusEnvelope(envelope, options.now);
    if (busEnvelope === null) return 'skipped';
    const post = appendBusInbox(busEnvelope, { root: options.root, now: options.now });
    return post.status === 'posted' || post.status === 'duplicate' ? 'published' : 'failed';
  } catch { return 'failed'; }
}
