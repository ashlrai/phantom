/** The allowlisted app surface, on the existing authenticated loopback server. */
import { APP_ACTIONS, runAppsControl, type AppsControlDeps, type AppsRequest } from '../apps-control.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { defaultHostAppLauncher } from './app-launcher.js';
import type { ApiModule } from './api-modules.js';
import { tools } from './verse-mcp-computer.js';

export const APPS_CONTROL_PATH = '/api/verse/apps/control';
// A dedicated host session cannot borrow grants from a caller-selected agent chat.
const call: NonNullable<AppsControlDeps['call']> = async (name, args) => {
  const tool = tools.find(t => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: 'unsupported app tool' }] };
  return tool.handler(args, { sessionId: 'apps-control-console', desktop: true });
};

export function createAppsControlApi(deps: AppsControlDeps = {}): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== APPS_CONTROL_PATH) return false;
    if (method !== 'GET' && method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '') || req.headers['x-ashlr-channel'] === 'mobile') {
      sendJson(res, 403, { error: 'local request required' }); return true;
    }
    let input: AppsRequest = { action: 'list' };
    if (method === 'POST') {
      if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (!passesMutationGate(req, res, ctx.token)) return true;
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); } catch { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !['action', 'app', 'request'].includes(k))) {
        sendJson(res, 400, { error: 'invalid app request' }); return true;
      }
      const value = body as Record<string, unknown>;
      if (!APP_ACTIONS.some(a => a === value.action) || typeof value.app !== 'string' ||
        (value.request !== undefined && typeof value.request !== 'boolean')) {
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
