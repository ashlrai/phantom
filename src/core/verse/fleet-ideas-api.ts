/**
 * The Ideas view's typed API (RQ-IDEASLOOPN17DQ8), same core as the CLI:
 *   GET  /api/verse/fleet/control/ideas        -> IdeaListReport  (`phm ideas list`)
 *   POST /api/verse/fleet/control/ideas/queue  {id} -> QueueIdeaResult (`phm ideas queue <id>`)
 * Served through the fleet-control family (fleet-control-api.ts), like disk-runway, so it
 * stays outside the Tier-1 authority closure and the frozen A10 mount table. The POST
 * passes the same dispatch + mutation-token + JSON gate as every control write and only
 * writes a drop job through the drop-job writer.
 */
import { QueueIdeaError, queueIdea, readIdeaList, type IdeaListReport, type QueueIdeaResult } from '../fleet/bottleneck-ideas.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_IDEAS_PATH = '/api/verse/fleet/control/ideas';
export const VERSE_FLEET_IDEAS_QUEUE_PATH = '/api/verse/fleet/control/ideas/queue';

export interface FleetIdeasApiDeps {
  list?: () => Promise<IdeaListReport>;
  queue?: (id: unknown) => Promise<QueueIdeaResult>;
}

export function createFleetIdeasApi(deps: FleetIdeasApiDeps = {}): ApiModule {
  const list = deps.list ?? (() => readIdeaList());
  const queue = deps.queue ?? ((id: unknown) => queueIdea(id));
  return async (ctx, req, res, path, method) => {
    if (path === VERSE_FLEET_IDEAS_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      sendJson(res, 200, await list());
      return true;
    }
    if (path !== VERSE_FLEET_IDEAS_QUEUE_PATH) return false;
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    let body: unknown;
    try { body = JSON.parse(await readBody(req, 4_096)); } catch {
      sendJson(res, 400, { error: 'expected a bounded JSON body' });
      return true;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some(key => key !== 'id')) {
      sendJson(res, 400, { error: 'expected only id' });
      return true;
    }
    try {
      sendJson(res, 200, await queue((body as { id?: unknown }).id));
    } catch (e) {
      if (e instanceof QueueIdeaError) sendJson(res, e.status, { error: e.message });
      else sendJson(res, 500, { error: 'could not queue the idea' });
    }
    return true;
  };
}
export const handleFleetIdeasApi: ApiModule = createFleetIdeasApi();
