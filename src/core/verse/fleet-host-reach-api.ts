/** Read-only Fleet Host reach evidence, served as sub-paths of the existing
 * runtime-identity family so no new workbench route family is needed.
 * Never writes; never returns IPs, DNS names, keys or the home path (the core
 * readers sanitize). A throwing reader yields 200 with every field "unknown"
 * and a fixed reason, never the thrown message. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { UNKNOWN } from '../fleet/runtime-identity.js';
import {
  defaultTailnetPeersDeps,
  readTailnetPeers,
  type TailnetPeers,
  type TailnetPeersDeps,
} from '../fleet/tailnet-peers.js';
import {
  defaultPoolReachDeps,
  readPoolReach,
  type PoolReach,
  type PoolReachDeps,
} from '../fleet/pool-reach.js';

export const VERSE_FLEET_TAILNET_PEERS_PATH = '/api/verse/fleet/runtime-identity/tailnet-peers';
export const VERSE_FLEET_POOL_REACH_PATH = '/api/verse/fleet/runtime-identity/pool-reach';

export interface FleetHostReachApiDeps {
  tailnetDeps?: TailnetPeersDeps;
  poolDeps?: PoolReachDeps;
  /** Clock seam for tests; stamps generatedAt. */
  now?: () => Date;
}

export function createFleetHostReachApi(deps: FleetHostReachApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_TAILNET_PEERS_PATH && path !== VERSE_FLEET_POOL_REACH_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const generatedAt = now().toISOString();
    if (path === VERSE_FLEET_TAILNET_PEERS_PATH) {
      let peers: TailnetPeers;
      try {
        peers = readTailnetPeers(deps.tailnetDeps ?? defaultTailnetPeersDeps());
      } catch {
        peers = { asOf: generatedAt, self: UNKNOWN, peers: [], reasons: ['tailnet peers: reader failed; all fields unknown'] };
      }
      // Top-level spread: the desktop card reads `peers` at the top level.
      sendJson(res, 200, { v: 1, generatedAt, ...peers });
      return true;
    }
    let reach: PoolReach;
    try {
      const pool = deps.poolDeps ?? defaultPoolReachDeps();
      // readPoolReach copies a thrown config message into reasons[]; replace it
      // with a fixed string so no thrown text (paths, errno) reaches the body.
      reach = readPoolReach({
        ...pool,
        readConfig: () => {
          try { return pool.readConfig(); } catch { throw new Error('pool config unreadable'); }
        },
      });
    } catch {
      reach = { asOf: generatedAt, self: UNKNOWN, role: UNKNOWN, hosts: [], reasons: ['pool reach: reader failed; all fields unknown'] };
    }
    sendJson(res, 200, { v: 1, generatedAt, reach });
    return true;
  };
}

export const handleFleetHostReachApi: ApiModule = createFleetHostReachApi();
