/** Read-only: who is spending each plan. Same report as `phm usage producers --json`. */
import { join } from 'node:path';
import { defaultRunsDir } from '../fleet/landed-closes-read.js';
import { readUsageProducers, usageProducersHours } from '../fleet/usage-producers.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_USAGE_PRODUCERS_PATH = '/api/verse/fleet/usage/producers';

export interface FleetUsageProducersApiDeps { runsDir?: string; now?: () => number }

export function createFleetUsageProducersApi(deps: FleetUsageProducersApiDeps = {}): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_USAGE_PRODUCERS_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const hours = usageProducersHours(new URL(req.url ?? path, 'http://localhost').searchParams.get('since'));
    if (hours === null) { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'since takes a window like 90m, 6h or 2d, up to 7d' }); return true; }
    const runsDir = deps.runsDir ?? defaultRunsDir();
    sendJson(res, 200, sanitizePublicJson(await readUsageProducers({ runsDir, metricsPath: join(runsDir, 'metrics', 'jobs.jsonl'), hours, now: (deps.now ?? Date.now)() })));
    return true;
  };
}
export const handleFleetUsageProducersApi: ApiModule = createFleetUsageProducersApi();
