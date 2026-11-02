import { withCodexPeersSession, type LocusPeersEndpoint } from '../core/fleet/adapters/codex-peers.js';

export interface FleetBusPeersDeps {
  /** Locus CLI presence probe; defaults to locusAvailableAsync. */
  available?: () => boolean | Promise<boolean>;
  /** Defaults to the Locus CLI transport. */
  endpoint?: LocusPeersEndpoint;
}

/** Session ids are bounded before any I/O — the same limit the peers adapter enforces. */
const PEERS_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

/**
 * `ashlr fleet bus-peers [--session-id <id>]` — read-only Codex peers visibility
 * through the Locus peers contract. The choice is off when the locus CLI is
 * missing; every failure fails closed as 'unavailable' and child output is
 * never echoed. With a session id the adapter registers, relays one untrusted
 * inbox snapshot and always unregisters; nothing posts to the bus and no engine
 * action runs. Never throws.
 */
export async function cmdFleetBusPeers(args: string[], deps: FleetBusPeersDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: ashlr fleet bus-peers [--session-id <id>]\nReports the Codex transport; a session relays one untrusted inbox snapshot. No bus posts or engine runs.');
    return 0;
  }
  const emit = async (result: Record<string, unknown>, code: number): Promise<number> => {
    try { console.log(JSON.stringify(result)); } catch { return 1; }
    return code;
  };
  let sessionId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!, inline = /^--session-id=(.*)$/s.exec(token);
    if (inline === null && token !== '--session-id') return emit({ status: 'invalid' }, 2);
    const value = inline ? inline[1] : args[++i];
    if (value === undefined || value === '' || sessionId !== undefined) return emit({ status: 'invalid' }, 2);
    sessionId = value;
  }
  if (sessionId !== undefined && !PEERS_SESSION_ID.test(sessionId)) return emit({ status: 'invalid' }, 2);
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

