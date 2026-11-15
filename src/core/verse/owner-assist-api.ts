import { z } from 'zod';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { getOwnerAssist, type OwnerAssistService } from '../owner-assist/service.js';
import { VerseError } from './session-engine.js';
import type { ApiModule } from './api-modules.js';

/** Same read-session/dispatch/mutation boundaries as the workbench. JSON only. */
export function createOwnerAssistApi(service: () => OwnerAssistService = getOwnerAssist): ApiModule {
  return async (ctx, req, res, path, method) => {
    const base = '/api/verse/owner-assist';
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    if (!ctx.readSession || ctx.readSession.expiresAt <= Date.now()) { sendJson(res, 401, { error: 'Read session required.' }); return true; }
    if (method !== 'GET' && method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }); return true; }
    if (method === 'POST') {
      if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (!passesMutationGate(req, res, ctx.token)) return true;
    }
    try {
      if (new URL(req.url ?? path, 'http://localhost').search) throw new VerseError('VERSE_INVALID', 'Query parameters are not supported.');
      const owner = service();
      const match = path.match(/^\/api\/verse\/owner-assist\/sessions\/([a-f0-9-]{36})(\/cancel)?$/);
      if (method === 'GET') {
        if (path === base) sendJson(res, 200, await owner.snapshot(ctx.cfg));
        else if (path === `${base}/handoffs`) sendJson(res, 200, await owner.handoffs());
        else if (match && !match[2]) sendJson(res, 200, owner.detail(match[1]!));
        else sendJson(res, 404, { error: 'Owner Assist route not found.' });
        return true;
      }
      let raw: string;
      try { raw = await readBody(req, 64 * 1024); }
      catch { sendJson(res, 413, { error: 'Request is too large.' }); return true; }
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new VerseError('VERSE_INVALID', 'Use a JSON object.'); }
      if (path === `${base}/turns`) {
        const port = req.socket?.localPort;
        if (!port) throw new Error('Sidecar port unavailable');
        sendJson(res, 202, await owner.send(body, ctx.cfg, `http://127.0.0.1:${port}`));
      } else if (path === `${base}/preferences`) sendJson(res, 200, await owner.configure(body));
      else if (path === `${base}/memory`) sendJson(res, 200, await owner.remember(body));
      else if (path === `${base}/handoffs`) sendJson(res, 201, await owner.handoff(body));
      else if (match?.[2]) { z.object({}).strict().parse(body); sendJson(res, 200, owner.cancel(match[1]!)); }
      else sendJson(res, 404, { error: 'Owner Assist route not found.' });
    } catch (error) {
      if (error instanceof VerseError) sendJson(res, error.status, { code: error.code, error: error.message });
      else if (error instanceof z.ZodError) sendJson(res, 400, { code: 'VERSE_INVALID', error: 'Invalid Owner Assist input. Check paths, lengths and credentials.' });
      else sendJson(res, 503, { code: 'OWNER_UNAVAILABLE', error: 'Owner Assist is unavailable. Existing state was preserved.' });
    }
    return true;
  };
}
export const handleOwnerAssistApi = createOwnerAssistApi();
