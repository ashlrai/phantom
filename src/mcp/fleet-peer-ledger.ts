/** Read-only peer bus budget evidence for the isolated fleet MCP server. */
import {
  peerPairSelectorSchema, readPeerLedger, type PeerLedgerReport, type PeerPairSelector,
} from '../core/agentnet/peer-ledger.js';
import { PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS } from '../core/agentnet/peer-bus.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const NOTE = 'Read-only peer bus budget metadata from this computer: per-pair sends left in the current window, live row capacity and origins near the hop cap. Grants no send, claim or dispatch authority. Pass fromAgent and target together to inspect one exact pair, including pairs the 64-row display cap would hide; a missing match is not proof of enrollment or quota. No caller root, path or cwd is accepted, and the tool never writes.';

export interface FleetPeerLedgerArgs {
  /** Exact pair selector; absent lists the truncated aggregate report. */
  pair?: PeerPairSelector;
}

export interface FleetPeerLedgerDeps {
  /** Reader seam; defaults to the real ledger over the server-owned root. */
  read?: (pair?: PeerPairSelector) => PeerLedgerReport;
}

/** Either an empty call or the complete strict pair — nothing in between. */
export function parseFleetPeerLedgerArgs(args: Record<string, unknown>): FleetPeerLedgerArgs | null {
  if (Object.keys(args).length === 0) return {};
  const parsed = peerPairSelectorSchema.safeParse(args);
  return parsed.success ? { pair: parsed.data } : null;
}

export function readFleetPeerLedger(options: FleetPeerLedgerArgs & FleetPeerLedgerDeps = {}) {
  let report: PeerLedgerReport;
  try {
    const read = options.read ?? ((pair?: PeerPairSelector) => readPeerLedger({ pair }));
    report = options.pair === undefined ? read() : read(options.pair);
  } catch {
    report = {
      v: 1, authority: 'none', status: 'unavailable', reason: 'peer-ledger-reader-failed',
      asOf: new Date().toISOString(), liveRows: 0, capacity: 1024,
      windowMs: PEER_WINDOW_MS, pairLimit: PEER_PAIR_LIMIT, maxHops: PEER_MAX_HOPS,
      pairs: [], origins: [], truncated: { pairs: false, origins: false },
    };
  }
  return sanitizePublicJson({ ...report, note: NOTE });
}
