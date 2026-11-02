import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';
import { withCodexBusPeersSession } from '../core/fleet/adapters/bus-peer-relay.js';
import { withCodexPeersSession, type LocusPeersEndpoint } from '../core/fleet/adapters/codex-peers.js';

export interface FleetBusPeersDeps {
  /** Locus CLI presence probe; defaults to locusAvailableAsync. */
  available?: () => boolean | Promise<boolean>;
  /** Defaults to the Locus CLI transport. */
  endpoint?: LocusPeersEndpoint;
  /** Isolated bus storage root, primarily for tests. */
  busRoot?: string;
}

/** Session ids are bounded before any I/O — the same limit the peers adapter enforces. */
const PEERS_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

/**
 * `ashlr fleet bus-peers [--session-id <id>] [--to <recipient>]` — Codex peers visibility
 * through the Locus peers contract. The choice is off when the locus CLI is
 * missing; every failure fails closed as 'unavailable' and child output is
 * never echoed. With a session id the adapter registers, relays one untrusted
 * inbox snapshot and always unregisters. An explicit recipient delivers the
 * snapshot to the bus as untrusted data. Never throws.
 */
export async function cmdFleetBusPeers(args: string[], deps: FleetBusPeersDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: ashlr fleet bus-peers [--session-id <id>] [--to <recipient>]\nReports the Codex transport; --to delivers one untrusted session snapshot to the bus.');
    return 0;
  }
  const emit = async (result: Record<string, unknown>, code: number): Promise<number> => {
    try { console.log(JSON.stringify(result)); } catch { return 1; }
    return code;
  };
  let sessionId: string | undefined, to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!, match = /^(--session-id|--to)(?:=(.*))?$/s.exec(token);
    if (!match) return emit({ status: 'invalid' }, 2);
    const value = match[2] ?? args[++i];
    if (!value || (match[1] === '--session-id' ? sessionId !== undefined : to !== undefined)) {
      return emit({ status: 'invalid' }, 2);
    }
    if (match[1] === '--session-id') sessionId = value;
    else to = value;
  }
  if (sessionId !== undefined && !PEERS_SESSION_ID.test(sessionId)) return emit({ status: 'invalid' }, 2);
  if (to !== undefined && (sessionId === undefined || !validateBusEnvelope({
    id: 'validation', from: 'locus-peers', to, priority: 'P2', ttl: 1, body: null,
  }).ok)) return emit({ status: 'invalid' }, 2);
  const identity = { client: 'codex', transport: 'locus-peers' } as const;
  let available = false;
  try {
    const probe = deps.available ?? (await import('../core/integrations/locus.js')).locusAvailableAsync;
    available = await probe();
  } catch { /* A probe failure is indistinguishable from a missing CLI: stay off. */ }
  if (!available) return emit({ status: 'unavailable', peers: { ...identity, locus: 'missing' } }, 1);
  if (sessionId === undefined) {
    return emit({ status: 'ok', peers: { ...identity, locus: 'present', contract: 'unverified' }, read: 'fleet bus-peers --session-id <id>' }, 0);
  }
  try {
    if (to !== undefined) {
      await withCodexBusPeersSession({
        sessionId, to, endpoint: deps.endpoint, busOptions: { root: deps.busRoot },
        run: async () => undefined,
      });
      return emit({ status: 'ok', delivery: 'confirmed' }, 0);
    }
    let messages: unknown[] = [];
    await withCodexPeersSession({
      sessionId,
      endpoint: deps.endpoint,
      relay: async (inbox) => { messages = JSON.parse(inbox.data) as unknown[]; },
      run: async () => undefined,
    });
    return emit({ status: 'ok', peers: { ...identity, source: 'locus-peers', trust: 'untrusted', sessionId, messages } }, 0);
  } catch {
    return emit({ status: 'unavailable', peers: { ...identity } }, 1);
  }
}

