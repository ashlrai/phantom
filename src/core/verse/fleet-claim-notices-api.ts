import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readClaimNoticeView } from '../fleet/claim-notice-view.js';

/** Read-only: the view never sends, ledgers or appends to the bus. */
export function createFleetClaimNoticesApi(read: () => unknown = () => readClaimNoticeView()): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/claim-notices') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'query parameters are not supported' }); return true; }
    try { sendJson(res, 200, await read()); }
    catch { sendJson(res, 503, { error: 'claim notices unavailable' }); }
    return true;
  };
}
export const handleFleetClaimNoticesApi = createFleetClaimNoticesApi();
