/** Safari, the agent browser, on the Apps API family: the same reports as `phm browser --json`. */
import { readFile } from 'node:fs/promises';
import { defaultShotFile, runBrowser, type BrowserDeps, type BrowserRequest } from '../browser-control.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

/** GET: open agent tabs and the latest screenshot's time. POST { action: open|shot|close, url? }. */
export const APPS_BROWSER_PATH = '/api/verse/apps/browser';
/** GET: `phm browser doctor --json`. */
export const APPS_BROWSER_DOCTOR_PATH = `${APPS_BROWSER_PATH}/doctor`;
/** GET: the latest screenshot as { version, dataUrl }; 404 when there is none. */
export const APPS_BROWSER_SHOT_PATH = `${APPS_BROWSER_PATH}/shot`;
const SHOT_MAX_BYTES = 8 * 1024 * 1024;

export function createAppsBrowserApi(deps: BrowserDeps = {}): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== APPS_BROWSER_PATH && path !== APPS_BROWSER_DOCTOR_PATH && path !== APPS_BROWSER_SHOT_PATH) return false;
    if (method !== 'GET' && (method !== 'POST' || path !== APPS_BROWSER_PATH)) { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '') || req.headers['x-ashlr-channel'] === 'mobile') {
      sendJson(res, 403, { error: 'local request required' }); return true;
    }
    try {
      if (path === APPS_BROWSER_SHOT_PATH) {
        const file = deps.shotFile ?? defaultShotFile();
        const bytes = await readFile(file).catch(() => null);
        if (!bytes || bytes.length === 0 || bytes.length > SHOT_MAX_BYTES) sendJson(res, 404, { error: 'no screenshot yet' });
        else sendJson(res, 200, { version: 1, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
        return true;
      }
      let input: BrowserRequest = { action: path === APPS_BROWSER_DOCTOR_PATH ? 'doctor' : 'tabs' };
      if (method === 'POST') {
        if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
        if (!passesMutationGate(req, res, ctx.token)) return true;
        let body: unknown;
        try { body = JSON.parse(await readBody(req)); } catch { body = null; }
        const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
        // No file path is accepted here: the API only writes the card's own screenshot file.
        if (!value || Object.keys(value).some(k => !['action', 'url', 'browser'].includes(k)) || !['open', 'shot', 'close'].includes(value.action as string) ||
          [value.url, value.browser].some(v => v !== undefined && typeof v !== 'string')) {
          sendJson(res, 400, { error: 'invalid browser request' }); return true;
        }
        input = value as unknown as BrowserRequest;
      }
      const result = await runBrowser(input, deps);
      // Reads answer 200 with the report, so the card can show why state is unknown.
      sendJson(res, method === 'GET' || result.exit === 0 ? 200 : result.exit === 2 ? 400 : 422, result.report);
    } catch { sendJson(res, 503, { error: 'browser unavailable' }); }
    return true;
  };
}
export const handleAppsBrowserApi = createAppsBrowserApi();
