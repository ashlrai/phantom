/** GET /api/verse/fleet/merge-pace: read-only merge pace report; same builder as `ashlr fleet merge-pace`. */
import { mergeGraph } from '../fleet/merge-graph.js';
import { fleetMergePace, type MergePaceReader } from '../fleet/merge-pace.js';
import { readTaskCheckJobs } from '../../cli/fleet-task-check.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export function createMergePaceApi(read: MergePaceReader = readTaskCheckJobs, now: () => number = Date.now): ApiModule {
  return async (_ctx, _req, res, path, method) => {
    if (path !== '/api/verse/fleet/merge-pace' && path !== '/api/verse/metrics/merges') return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    if (path === '/api/verse/metrics/merges') {
      let raw: string | null;
      try { raw = await read(); } catch { raw = null; }
      sendJson(res, 200, mergeGraph(raw, now()));
      return true;
    }
    // fleetMergePace turns reader failures into known:false, rows:null.
    sendJson(res, 200, await fleetMergePace(read, now()));
    return true;
  };
}

export const handleMergePaceApi: ApiModule = createMergePaceApi();
