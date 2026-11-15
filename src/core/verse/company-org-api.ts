import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readCompanyOrg } from '../org/company-view.js';

export function createCompanyOrgApi(read = readCompanyOrg): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/org') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'query parameters are not supported' }); return true; }
    try { sendJson(res, 200, await read()); }
    catch { sendJson(res, 503, { error: 'organization observation unavailable' }); }
    return true;
  };
}
export const handleCompanyOrgApi = createCompanyOrgApi();
