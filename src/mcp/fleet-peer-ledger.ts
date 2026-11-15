/** Read-only peer bus budget evidence for the isolated fleet MCP server. */
import { readPeerLedger, type PeerLedgerReport } from '../core/agentnet/peer-ledger.js';
import { PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS } from '../core/agentnet/peer-bus.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const NOTE = 'Read-only peer bus budget metadata from this computer: per-pair sends left in the current window, live row capacity and origins near the hop cap. Grants no send, claim or dispatch authority. Takes no arguments and never writes.';

export function parseFleetPeerLedgerArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

export function readFleetPeerLedger(deps: { read?: () => PeerLedgerReport } = {}) {
  let report: PeerLedgerReport;
  try {
    report = (deps.read ?? readPeerLedger)();
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
