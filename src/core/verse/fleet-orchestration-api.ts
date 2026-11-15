import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readFleetOrchestration } from '../../mcp/fleet-orchestration-read.js';

export const ORCHESTRATION_TIMEOUT_MS = 5_000;

/** Read-only projection of the leader journal; never writes or claims work. */
export function createFleetOrchestrationApi(
  read: () => Awaited<ReturnType<typeof readFleetOrchestration>> | Promise<Awaited<ReturnType<typeof readFleetOrchestration>>> = () => readFleetOrchestration({ limit: 25 }),
): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/orchestration') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'query parameters are not supported' }); return true; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const trace = await Promise.race([
        Promise.resolve().then(read),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ORCHESTRATION_TIMEOUT_MS); }),
      ]);
      sendJson(res, 200, trace);
    } catch { sendJson(res, 503, { error: 'orchestration journal unavailable' }); }
    finally { if (timer) clearTimeout(timer); }
    return true;
  };
}
export const handleFleetOrchestrationApi = createFleetOrchestrationApi();
