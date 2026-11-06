/** GET /api/verse/fleet/landed-closes: read-only view of the stale PRs `ashlr fleet landed-close` cleared. */
import { readLandedCloses, type LandedClosesReport } from '../fleet/landed-closes-read.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export function createLandedClosesApi(
  read: (now: number) => Promise<LandedClosesReport> = now => readLandedCloses(undefined, now),
  now: () => number = Date.now,
): ApiModule {
  return async (_ctx, _req, res, path, method) => {
    if (path !== '/api/verse/fleet/landed-closes') return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    sendJson(res, 200, await read(now()));
    return true;
  };
}

export const handleLandedClosesApi: ApiModule = createLandedClosesApi();
