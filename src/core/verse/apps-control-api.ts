/** The allowlisted app surface, on the existing authenticated loopback server. */
import { APP_ACTIONS, runAppsControl, type AppsControlDeps, type AppsRequest } from '../apps-control.js';
import { readAppActions, type AppActionsDeps } from '../apps-actions.js';
import { readMacApps } from '../apps-known.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { defaultHostAppLauncher } from './app-launcher.js';
import type { ApiModule } from './api-modules.js';
import { tools } from './verse-mcp-computer.js';

export const APPS_CONTROL_PATH = '/api/verse/apps/control';
/** GET: the known Mac apps (`phm apps --json`). Actions POST to APPS_CONTROL_PATH with the app id. */
export const APPS_MAC_PATH = '/api/verse/apps/mac';
/** GET: the app action log (`phm apps log --json`), newest first; `?limit=` up to 200. Read-only. */
export const APPS_ACTIONS_PATH = '/api/verse/apps/actions';
// A dedicated host session cannot borrow grants from a caller-selected agent chat.
const call: NonNullable<AppsControlDeps['call']> = async (name, args) => {
  const tool = tools.find(t => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: 'unsupported app tool' }] };
  return tool.handler(args, { sessionId: 'apps-control-console', desktop: true });
};

export function createAppsControlApi(deps: AppsControlDeps & AppActionsDeps = {}): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== APPS_CONTROL_PATH && path !== APPS_MAC_PATH && path !== APPS_ACTIONS_PATH) return false;
    if (method !== 'GET' && (method !== 'POST' || path !== APPS_CONTROL_PATH)) { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '') || req.headers['x-ashlr-channel'] === 'mobile') {
      sendJson(res, 403, { error: 'local request required' }); return true;
    }
    if (path === APPS_MAC_PATH) {
      try { sendJson(res, 200, await readMacApps({ probe: deps.probe, home: deps.home })); }
      catch { sendJson(res, 503, { error: 'app state unavailable' }); }
      return true;
    }
    if (path === APPS_ACTIONS_PATH) {
      const limit = new URL(req.url ?? '', 'http://localhost').searchParams.get('limit');
      if (limit !== null && !/^[1-9]\d{0,2}$/.test(limit)) { sendJson(res, 400, { error: 'invalid limit' }); return true; }
      try { sendJson(res, 200, readAppActions(deps, limit === null ? undefined : Number(limit))); }
      catch { sendJson(res, 503, { error: 'app actions unavailable' }); }
      return true;
    }
    let input: AppsRequest = { action: 'list' };
    if (method === 'POST') {
      if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (!passesMutationGate(req, res, ctx.token)) return true;
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); } catch { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !['action', 'app', 'request', 'dryRun'].includes(k))) {
        sendJson(res, 400, { error: 'invalid app request' }); return true;
      }
      const value = body as Record<string, unknown>;
      if (!APP_ACTIONS.some(a => a === value.action) || typeof value.app !== 'string' ||
        (value.request !== undefined && typeof value.request !== 'boolean') ||
        (value.dryRun !== undefined && typeof value.dryRun !== 'boolean')) {
        sendJson(res, 400, { error: 'invalid app request' }); return true;
      }
      input = value as unknown as AppsRequest;
    }
    try {
      const result = await runAppsControl(input, { call, launcher: defaultHostAppLauncher(), ...deps });
      sendJson(res, result.exit === 0 ? 200 : result.exit === 3 ? 202 : result.exit === 2 ? 400 : 422, result.report);
    } catch { sendJson(res, 503, { error: 'app control unavailable' }); }
    return true;
  };
}
export const handleAppsControlApi = createAppsControlApi();
