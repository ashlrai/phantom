/**
 * GET /api/verse/fleet/control/org-groups: the fleet.org-groups.v1 tree behind
 * `phm fleet org --json` and the Map pane's "By org" layout. It groups the same
 * live map `phm map` prints (core/fleet/org-groups.ts); it reads nothing else.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fleetOrgGroups, type FleetOrgGroups } from '../fleet/org-groups.js';
import { readFleetLiveMap, throttledLiveMap } from './fleet-live-map-api.js';
import type { FleetLiveMap } from '../fleet/live-map.js';

export const ORG_GROUPS_PATH = '/api/verse/fleet/control/org-groups';

export async function readFleetOrgGroups(read: () => Promise<FleetLiveMap> = () => readFleetLiveMap()): Promise<FleetOrgGroups> {
  return fleetOrgGroups(await read());
}

export function createFleetOrgGroupsApi(read: () => Promise<FleetLiveMap> = throttledLiveMap(() => readFleetLiveMap())): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== ORG_GROUPS_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'The org takes no query.' }); return true; }
    try { sendJson(res, 200, await readFleetOrgGroups(read)); }
    catch { sendJson(res, 503, { error: 'Fleet org unavailable.' }); }
    return true;
  };
}
export const handleFleetOrgGroupsApi = createFleetOrgGroupsApi();
