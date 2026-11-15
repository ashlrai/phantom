/** Read-only peer-bus budget evidence for the Verse API. Metadata only; never writes. */
import type { IncomingMessage } from 'node:http';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS } from '../agentnet/peer-bus.js';
import {
  peerPairSelectorSchema,
  readPeerLedger,
  type PeerLedgerReport,
  type PeerPairSelector,
} from '../agentnet/peer-ledger.js';

export const VERSE_FLEET_PEER_LEDGER_PATH = '/api/verse/fleet/peer-ledger';

export interface FleetPeerLedgerApiDeps {
  /** Reader seam for tests. Default: the server-owned peer ledger root. */
  read?: (pair?: PeerPairSelector) => PeerLedgerReport;
  /** Clock seam for the fixed reader-failure fallback. */
  now?: () => Date;
}

function unavailableReport(asOf: string): PeerLedgerReport {
  return {
    v: 1, authority: 'none', status: 'unavailable', reason: 'peer-ledger-reader-failed', asOf,
    liveRows: 0, capacity: 1024, windowMs: PEER_WINDOW_MS, pairLimit: PEER_PAIR_LIMIT, maxHops: PEER_MAX_HOPS,
    pairs: [], origins: [], truncated: { pairs: false, origins: false },
  };
}

function fallbackAsOf(now: () => Date): string {
  try {
    return now().toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function parseQuery(req: IncomingMessage): { pair?: PeerPairSelector } | null {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return null;
  }
  const keys = [...new Set(params.keys())];
  if (keys.length === 0) return {};
  if (keys.some((key) => key !== 'fromAgent' && key !== 'target')) return null;
  if (keys.some((key) => params.getAll(key).length !== 1)) return null;
  const fromAgent = params.get('fromAgent');
  const target = params.get('target');
  if ((fromAgent === null) !== (target === null)) return null;
  if (fromAgent === null || target === null) return {};
  const parsed = peerPairSelectorSchema.safeParse({ fromAgent, target });
  return parsed.success ? { pair: parsed.data } : null;
}

export function createFleetPeerLedgerApi(deps: FleetPeerLedgerApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const read = deps.read ?? ((pair?: PeerPairSelector) => readPeerLedger({ pair }));
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_PEER_LEDGER_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const query = parseQuery(req);
    if (query === null) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid peer-ledger query' });
      return true;
    }
    let report: PeerLedgerReport;
    try {
      const candidate = read(query.pair);
      report = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
        ? { ...candidate, v: 1, authority: 'none' }
        : unavailableReport(fallbackAsOf(now));
    } catch {
      report = unavailableReport(fallbackAsOf(now));
    }
    sendJson(res, 200, report);
    return true;
  };
}

export const handleFleetPeerLedgerApi: ApiModule = createFleetPeerLedgerApi();
