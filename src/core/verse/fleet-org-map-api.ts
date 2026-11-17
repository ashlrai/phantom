import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { buildFleetLiveSnapshot } from './fleet-live-api.js';
import { getFleetSessions } from '../fleet/runs-sessions.js';
import { readFleetEdges } from '../fleet/fleet-edges.js';
import { fleetOrgMap, mapWindowMinutes } from '../fleet/org-map.js';

export async function readFleetOrgMap(minutes = 60) {
  mapWindowMinutes(String(minutes));
  const now = Date.now();
  const [live, sessions] = await Promise.allSettled([buildFleetLiveSnapshot(), getFleetSessions({ now: () => now })]);
  const messages = readFleetEdges({ now: () => now, windowMinutes: minutes });
  return fleetOrgMap(live.status === 'fulfilled' ? live.value.snapshot : null, {
    sessions: sessions.status === 'fulfilled' ? sessions.value : null, messages, minutes, now,
  });
}
export function createFleetOrgMapApi(read = readFleetOrgMap): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/map') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    let minutes: number;
    try {
      const params = new URL(req.url ?? path, 'http://localhost').searchParams;
      if ([...params.keys()].some(key => key !== 'minutes') || params.getAll('minutes').length > 1) throw new Error('Invalid query');
      minutes = mapWindowMinutes(params.get('minutes') ?? undefined);
    } catch { sendJson(res, 400, { error: 'Use minutes=1..1440 only.' }); return true; }
    try { sendJson(res, 200, await read(minutes)); }
    catch { sendJson(res, 503, { error: 'Fleet map unavailable.' }); }
    return true;
  };
}
export const handleFleetOrgMapApi = createFleetOrgMapApi();
