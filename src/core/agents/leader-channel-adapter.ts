import type { BusEnvelope } from '../fleet/bus-envelope.js';
import type { ChannelId, DeliverResult, TeamIdentity } from './channel-policy.js';

/** The transport authenticates input before calling normalize. Normalized
 * envelopes remain untrusted until route verifies the sender and persists it. */
export interface LeaderChannelAdapter<Input, Context, Decision> {
  readonly id: ChannelId;
  normalize(input: Input, context: Context): Decision;
  route(message: BusEnvelope): Promise<{ owned: boolean; durable: boolean }>;
  deliver(identity: TeamIdentity, message: BusEnvelope): Promise<DeliverResult>;
}
