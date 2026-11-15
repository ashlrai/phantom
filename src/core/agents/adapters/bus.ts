/** Local bus ChannelAdapter. Delivery appends to the durable inbox and does not dispatch work. */
import { randomUUID } from 'node:crypto';
import type { BusEnvelope } from '../../fleet/bus-envelope.js';
import { validateBusEnvelope } from '../../fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from '../../fleet/bus-inbox.js';
import { shouldIngestFromBridge, type ChannelAdapter, type DeliverResult } from '../channel-policy.js';
import { localWriteGate, outboundGate } from '../send-gate.js';

const BUS_ADAPTER_ID = 'bus' as const;
const MAX_PAGES = 12;

export interface LocalAdapterOptions extends BusInboxOptions {
  enforcePolicy?: boolean;
}

export async function* readChannel(channel: 'bus' | 'handoff', options: BusInboxOptions): AsyncIterable<BusEnvelope> {
  let after = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = listBusInboxAfter(after, 100, options);
    if (result.status !== 'ok') return;
    for (const row of result.messages) {
      const envelope = row.envelope;
      const id = envelope.channel ?? 'bus';
      if (id !== channel || !shouldIngestFromBridge(envelope, channel)) continue;
      yield envelope;
    }
    if (result.messages.length === 0 || result.nextCursor <= after) return;
    after = result.nextCursor;
  }
}

export async function deliverLocalEnvelope(message: unknown, channel: 'bus' | 'handoff', options: LocalAdapterOptions = {}): Promise<DeliverResult> {
  const checked = validateBusEnvelope(message);
  if (!checked.ok) return { status: 'refused', reason: 'Envelope is not a valid bus message.' };
  const envelope = checked.value;
  if ((envelope.channel ?? channel) !== channel) return { status: 'refused', reason: 'Envelope is for a different channel.' };
  const blocked = localWriteGate();
  if (blocked) return blocked;
  if (options.enforcePolicy !== false) {
    const decision = outboundGate({
      channel, recipientId: envelope.to, external: envelope.external === true,
    });
    if (decision) return decision;
  }
  const post = appendBusInbox({ ...envelope, channel }, options);
  if (post.status === 'posted' || post.status === 'duplicate') {
    return { status: 'sent', reason: 'Recorded in the local bus store.' };
  }
  if (post.status === 'retryable') return { status: 'refused', reason: 'Bus store is busy.' };
  return { status: 'refused', reason: 'Bus store refused the envelope.' };
}

export function probeEnvelope(channel: 'bus' | 'handoff'): BusEnvelope {
  return {
    id: `probe-${randomUUID()}`,
    from: 'local-probe',
    to: 'local-probe',
    priority: 'P3',
    ttl: 60_000,
    body: { kind: 'note', text: 'local channel probe' },
    channel,
    channel_ref: 'local-probe',
    sender: { agent_id: 'local-probe', vendor: 'phantom', human: false, team: true },
    external: false,
    origin_bridge: 'channel-probe',
  };
}

export function createBusChannelAdapter(options: BusInboxOptions = {}): ChannelAdapter {
  return {
    id: BUS_ADAPTER_ID,
    ingest: () => readChannel('bus', options),
    deliver: message => deliverLocalEnvelope(message, 'bus', { ...options, enforcePolicy: true }),
  };
}

export function probeBusChannel(options: BusInboxOptions = {}): Promise<DeliverResult> {
  return deliverLocalEnvelope(probeEnvelope('bus'), 'bus', { ...options, enforcePolicy: false });
}
