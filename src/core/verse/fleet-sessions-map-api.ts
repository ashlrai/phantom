import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readFleetSessionMap } from '../fleet/sessions-view.js';

export function createFleetSessionsMapApi(read = readFleetSessionMap): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/sessions') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'query parameters are not supported' }); return true; }
    try { sendJson(res, 200, await read()); }
    catch { sendJson(res, 503, { error: 'session observation unavailable' }); }
    return true;
  };
}
export const handleFleetSessionsMapApi = createFleetSessionsMapApi();
