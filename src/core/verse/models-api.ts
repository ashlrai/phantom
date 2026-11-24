/**
 * The Models panel's typed API, the same core as the CLI:
 *   GET  /api/verse/fleet/control/models                      -> ModelRegistryList (`phm models --json` registry)
 *   GET  /api/verse/fleet/control/models/check                -> ModelCheckReport  (`phm models check --json`)
 *   POST /api/verse/fleet/control/models/verify {id, source}  -> ModelRegistryRow  (`phm models verify <id> --source <url>`)
 * Served through the fleet-control family, like the Ideas view. The POST passes the same
 * dispatch + mutation-token + JSON gate as every control write, and the core only marks a
 * model verified after its official doc page names the exact id.
 */
import { checkModels, type ModelCheckReport } from '../fleet/model-check.js';
import { listModelRegistry, markModelVerified, ModelVerifyRefusal, type ModelRegistryList, type ModelRegistryRow } from '../fleet/model-verify.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_MODELS_PATH = '/api/verse/fleet/control/models';
export const VERSE_MODELS_CHECK_PATH = '/api/verse/fleet/control/models/check';
export const VERSE_MODELS_VERIFY_PATH = '/api/verse/fleet/control/models/verify';

export interface ModelsApiDeps {
  list?: () => Promise<ModelRegistryList>;
  check?: () => Promise<ModelCheckReport>;
  verify?: (input: { id: string; source: string }) => Promise<ModelRegistryRow>;
}

export function createModelsApi(deps: ModelsApiDeps = {}): ApiModule {
  const list = deps.list ?? (() => listModelRegistry());
  const check = deps.check ?? (() => checkModels());
  const verify = deps.verify ?? (input => markModelVerified(input));
  return async (ctx, req, res, path, method) => {
    if (path === VERSE_MODELS_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      // An unreadable registry is an error, never an empty list: empty would read as "nothing to verify".
      try { sendJson(res, 200, await list()); } catch { sendJson(res, 500, { error: 'The model registry could not be read.' }); }
      return true;
    }
    if (path === VERSE_MODELS_CHECK_PATH) {
      if (method !== 'GET') sendJson(res, 405, { error: 'method not allowed' });
      // An unreadable registry is a 200 with registry "unknown": the report itself says nothing is routable.
      else sendJson(res, 200, await check());
      return true;
    }
    if (path !== VERSE_MODELS_VERIFY_PATH) return false;
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    let body: unknown;
    try { body = JSON.parse(await readBody(req, 4_096)); } catch { body = null; }
    const { id, source, ...rest } = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : { extra: true }) as Record<string, unknown>;
    if (typeof id !== 'string' || typeof source !== 'string' || Object.keys(rest).length) {
      sendJson(res, 400, { error: 'expected only id and source' });
      return true;
    }
    try {
      sendJson(res, 200, await verify({ id, source }));
    } catch (e) {
      if (e instanceof ModelVerifyRefusal) sendJson(res, 422, { error: e.message });
      else sendJson(res, 500, { error: 'The model registry could not be updated.' });
    }
    return true;
  };
}
export const handleModelsApi: ApiModule = createModelsApi();
