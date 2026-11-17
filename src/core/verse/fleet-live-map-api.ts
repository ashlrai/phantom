/**
 * GET /api/verse/fleet/control/live-map: the fleet.live-map.v1 graph behind
 * `phm map` and the desktop Map pane. Reads only what `phm org` and
 * `phm nodes` already read (core/fleet/live-map.ts joins them).
 *
 * Fast by construction: one graph build serves every caller for 5 seconds,
 * and callers that arrive while a build is running share it, so the map costs
 * at most one fleet read per 5 s however many panes or agents poll it.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { buildFleetLiveMap, LIVE_MAP_WINDOW_MINUTES, type FleetLiveMap } from '../fleet/live-map.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const LIVE_MAP_PATH = '/api/verse/fleet/control/live-map';
export const LIVE_MAP_MIN_INTERVAL_MS = 5_000;

/** Build the graph from the shared reads. Each source fails on its own into "unknown". */
export async function readFleetLiveMap(now = Date.now()): Promise<FleetLiveMap> {
  const [{ readFleetOrgSources }, { defaultNodesViewDeps, readNodesView }] = await Promise.all([
    import('./fleet-org-map-api.js'), import('../fleet/nodes-view.js')]);
  const org = await readFleetOrgSources(LIVE_MAP_WINDOW_MINUTES).catch(() => null);
  let computers = null;
  try { computers = readNodesView(defaultNodesViewDeps()); } catch { /* unknown, listed in gaps */ }
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  return sanitizePublicJson(buildFleetLiveMap({ org: org?.map ?? null, usage: org?.usage ?? null, computers, now })) as FleetLiveMap;
}

/** At most one `read` per interval; concurrent callers share the build in flight. A failed build is not kept. Also throttles the Sessions read. */
export function throttledLiveMap<T = FleetLiveMap>(read: () => Promise<T>, clock: () => number = Date.now, intervalMs = LIVE_MAP_MIN_INTERVAL_MS) {
  let last: { at: number; value: Promise<T> } | null = null;
  return (): Promise<T> => {
    const now = clock();
    if (last && now - last.at < intervalMs && now >= last.at) return last.value;
    const value = read();
    const entry = { at: now, value };
    last = entry;
    value.catch(() => { if (last === entry) last = null; });
    return value;
  };
}

export function createFleetLiveMapApi(read: () => Promise<FleetLiveMap> = throttledLiveMap(() => readFleetLiveMap())): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== LIVE_MAP_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'The map takes no query.' }); return true; }
    try { sendJson(res, 200, await read()); }
    catch { sendJson(res, 503, { error: 'Fleet map unavailable.' }); }
    return true;
  };
}
export const handleFleetLiveMapApi = createFleetLiveMapApi();
