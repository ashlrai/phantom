/** GET /api/verse/fleet/merge-cockpit: read-only rebase-treadmill report; same builder as `phm fleet merge-cockpit`. */
import { readMergeCockpit, VERSE_FLEET_MERGE_COCKPIT_PATH, type MergeCockpitReport } from '../fleet/merge-cockpit.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export function createMergeCockpitApi(
  read: (opts: { hours?: number; now?: number }) => Promise<MergeCockpitReport> = opts => readMergeCockpit(opts),
  now: () => number = Date.now,
): ApiModule {
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_MERGE_COCKPIT_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    sendJson(res, 200, await read({ now: now() }));
    return true;
  };
}

export const handleMergeCockpitApi: ApiModule = createMergeCockpitApi();
