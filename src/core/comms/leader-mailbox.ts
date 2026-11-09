/**
 * RQ-COMMS-UNIFIED-1 mailbox boundary for RQ-LEADER-CEO-1.
 *
 * The leader owns generation. This module is the only handoff: authenticated
 * owner text goes in, and a receipt comes back. Claim key `queue:RQ-COMMS-UNIFIED-1`
 * names this work on the agent bus. A claim coordinates; it grants no execution
 * authority. Credentials never cross this boundary.
 */
import type { BusChannel } from '../fleet/bus-envelope.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import { appendInboxEntry } from '../fleet/mason-inbox.js';
import { createLeaderNetwork } from '../agents/leader-network.js';
import { readLeaderNetworkConfig } from '../agents/leader-network-runtime.js';

export const OWNER_THREAD_CLAIM_KEY = 'queue:RQ-COMMS-UNIFIED-1';
export const OWNER_THREAD_ID = 'owner';

export const OWNER_CHANNELS = ['desktop', 'telegram', 'email', 'imessage', 'slack'] as const;
export type OwnerChannel = typeof OWNER_CHANNELS[number];

export interface LeaderMailboxMessage {
  channel: OwnerChannel;
  senderId: string;
  text: string;
  idempotencyKey: string;
  receivedAt: number;
}

export interface LeaderMailboxReceipt {
  status: 'accepted' | 'duplicate' | 'refused' | 'unavailable';
  requestId?: string;
  reason?: string;
}

/** The leader inbox/outbox plug. A parallel leader may replace the default. */
export interface LeaderMailbox {
  accept(message: LeaderMailboxMessage): Promise<LeaderMailboxReceipt>;
}

export function ownerChannelToBus(channel: OwnerChannel): BusChannel {
  switch (channel) {
    case 'desktop': return 'bus';
    case 'telegram': return 'telegram';
    case 'email': return 'email';
    case 'imessage': return 'imessage';
    case 'slack': return 'slack';
    default: {
      const unreachable: never = channel;
      return unreachable;
    }
  }
}

export function isOwnerChannel(value: string): value is OwnerChannel {
  return (OWNER_CHANNELS as readonly string[]).includes(value);
}

/** Default plug: the merged leader network inbox. iMessage text is not copied onto the bus by this call. */
export function createLeaderMailbox(options: { runsDir: string; configDir?: string; busRoot?: string; now?: () => number } = { runsDir: '' }): LeaderMailbox {
  return {
    async accept(message) {
      if (!options.runsDir) return { status: 'unavailable', reason: 'Leader mailbox is not configured.' };
      try {
        // iMessage text stays in the local leader inbox. It does not ride the shared bus.
        if (message.channel === 'imessage') {
          const written = await appendInboxEntry(message.text, {
            runsDir: options.runsDir, source: 'imessage', now: () => new Date(message.receivedAt),
          });
          return written.ok
            ? { status: 'accepted' as const, requestId: written.id }
            : { status: 'refused' as const, reason: 'Leader inbox refused the owner message.' };
        }
        const sources = readLeaderNetworkConfig({ configDir: options.configDir, runsDir: options.runsDir });
        const channel = ownerChannelToBus(message.channel);
        const network = createLeaderNetwork({
          ...sources,
          runsDir: options.runsDir,
          busRoot: options.busRoot,
          now: options.now,
        });
        const result = await network.ingest({
          message: {
            id: `own-${message.idempotencyKey}`,
            from: 'mason',
            to: 'leader',
            priority: 'P0',
            ttl: CHANNEL_BUS_TTL_MS,
            body: { kind: 'owner-thread', threadId: OWNER_THREAD_ID, channel: message.channel, text: message.text },
            channel,
            channel_ref: OWNER_THREAD_ID,
            sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true },
            external: false,
          },
          verifiedSender: { channel, id: message.senderId },
          receivedAt: message.receivedAt,
        });
        if (result.status === 'accepted' || result.status === 'duplicate') {
          return { status: result.status, requestId: result.requestId };
        }
        if (result.status === 'unavailable') return { status: 'unavailable', reason: 'Leader inbox is unavailable.' };
        return { status: 'refused', reason: 'Leader inbox refused the owner message.' };
      } catch {
        return { status: 'unavailable', reason: 'Leader inbox is unavailable.' };
      }
    },
  };
}
