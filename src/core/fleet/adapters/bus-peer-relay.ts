/** Locus peer snapshots enter the shared bus only as opaque untrusted data. */
import { randomUUID } from 'node:crypto';
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from '../bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../bus-envelope.js';
import { withCodexPeersSession, type UntrustedPeerInbox, type LocusPeersEndpoint } from './codex-peers.js';
import { withGrokPeersSession } from './grok-peers.js';

export interface BusPeerRelayOptions {
  /** Trusted caller supplies routing; peer text never selects the destination. */
  to: string;
  busOptions?: BusInboxOptions;
  write?: (envelope: BusEnvelope, options: BusInboxOptions) => BusInboxPost | Promise<BusInboxPost>;
}

/** Refuse invalid/oversize wire data before writing, and propagate any refusal. */
export function createBusPeerRelay(options: BusPeerRelayOptions): (inbox: UntrustedPeerInbox) => Promise<void> {
  return async (inbox) => {
    const checked = validateBusEnvelope({
      id: randomUUID(), from: 'locus-peers', to: options.to, priority: 'P2', ttl: 60_000,
      body: { source: 'locus-peers', trust: 'untrusted', sessionId: inbox.sessionId, data: inbox.data },
    });
    if (!checked.ok) throw new Error('Peer bus envelope refused: invalid or exceeds limit');
    const result = await (options.write ?? appendBusInbox)(checked.value, options.busOptions ?? {});
    if (result.status !== 'posted' && result.status !== 'duplicate') {
      throw new Error('Peer bus write failed');
    }
  };
}

interface BusPeersSessionOptions<T> extends BusPeerRelayOptions {
  sessionId: string;
  endpoint?: LocusPeersEndpoint;
  run: (relayInbox: () => Promise<void>) => Promise<T>;
}

/** A bus refusal prevents the CLI action; the adapter still unregisters. */
export function withCodexBusPeersSession<T>(options: BusPeersSessionOptions<T>): Promise<T> {
  return withCodexPeersSession({ ...options, relay: createBusPeerRelay(options) });
}

/** Grok shares the same opaque inbox contract and durable bus sink. */
export function withGrokBusPeersSession<T>(options: BusPeersSessionOptions<T>): Promise<T> {
  return withGrokPeersSession({ ...options, relay: createBusPeerRelay(options) });
}
