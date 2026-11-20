/**
 * GET /api/verse/fleet/control/nodes-pool: the phantom.nodes-pool.v1 report behind `phm nodes pool --json`
 * and the Machines card on the desktop and phone Home. Read-only; one build serves every caller for 5 seconds.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { defaultNodesViewDeps } from '../fleet/nodes-view.js';
import { readNodesPool, type NodesPool } from '../fleet/nodes-pool.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { throttledLiveMap } from './fleet-live-map-api.js';

export const NODES_POOL_PATH = '/api/verse/fleet/control/nodes-pool';

export function createFleetNodesPoolApi(read: () => Promise<NodesPool> = throttledLiveMap(async () => sanitizePublicJson(readNodesPool({ view: defaultNodesViewDeps() })) as NodesPool)): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== NODES_POOL_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'query parameters are not supported' }); return true; }
    try { sendJson(res, 200, await read()); }
    catch { sendJson(res, 503, { error: 'Machines unavailable.' }); }
    return true;
  };
}
export const handleFleetNodesPoolApi = createFleetNodesPoolApi();
