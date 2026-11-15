/** Handoff ChannelAdapter. Messages land on the same inbox receiveHandoffBus reads. */
import type { BusInboxOptions } from '../../fleet/bus-inbox.js';
import type { ChannelAdapter, DeliverResult } from '../channel-policy.js';
import { deliverLocalEnvelope, probeEnvelope, readChannel } from './bus.js';

export function createHandoffChannelAdapter(options: BusInboxOptions = {}): ChannelAdapter {
  return {
    id: 'handoff',
    ingest: () => readChannel('handoff', options),
    deliver: message => deliverLocalEnvelope(message, 'handoff', { ...options, enforcePolicy: true }),
  };
}

export function probeHandoffChannel(options: BusInboxOptions = {}): Promise<DeliverResult> {
  return deliverLocalEnvelope(probeEnvelope('handoff'), 'handoff', { ...options, enforcePolicy: false });
}
