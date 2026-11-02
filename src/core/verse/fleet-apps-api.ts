/** Bounded local desktop app control; no phone gateway mutations. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findAppControlScript, findInstalledAppControlScript, type FleetAppExec } from '../../cli/fleet-app.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const FLEET_APPS = ['Phantom', 'Codex', 'Claude', 'Grok Bot', 'ChatGPT', 'Cursor', 'Safari', 'Google Chrome'] as const;
const PATH = '/api/verse/fleet/apps';
const execAsync = promisify(execFile);
export interface FleetAppsApiDeps {
  exec?: FleetAppExec;
  locateScript?: () => string | null;
  now?: () => number;
  runsDir?: string;
}
interface AppsView {
  v: 1;
  generatedAt: string;
  available: boolean;
  apps: Array<{ app: string; running: boolean | null; checkedAt: string }>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function createFleetAppsApi(deps: FleetAppsApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  const root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const locate = deps.locateScript ?? (() => findAppControlScript() ?? findInstalledAppControlScript(root));
  const exec: FleetAppExec = deps.exec ?? (async (file, argv, options) => execAsync(file, argv, options));
  let cached: { at: number; view: Promise<AppsView> } | undefined;
  async function run(script: string, action: string, app: string, timeout: number): Promise<Record<string, unknown>> {
    let stdout: string;
    try {
      ({ stdout } = await exec('python3', ['-I', script, action, app, '--output-dir', root], {
        encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true,
      }));
    } catch (error) {
      const e = error as { code?: unknown; stdout?: unknown; killed?: unknown; signal?: unknown };
      // Script refusals exit nonzero but still return the JSON contract.
      if (typeof e.code !== 'number' || e.killed || e.signal || typeof e.stdout !== 'string') throw new Error('app control unavailable');
      stdout = e.stdout;
    }
    const parsed: unknown = JSON.parse(stdout);
    if (!record(parsed)) throw new Error('app control unavailable');
    return parsed;
  }
  async function snapshot(): Promise<AppsView> {
    const generatedAt = new Date(now()).toISOString();
    const script = locate();
    if (!script) return { v: 1, generatedAt, available: false, apps: [] };
    const apps: AppsView['apps'] = FLEET_APPS.map(app => ({ app, running: null, checkedAt: generatedAt }));
    const deadline = Date.now() + 20_000;
    let next = 0;
    async function worker() {
      while (next < apps.length) {
        const row = apps[next++]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        try {
          const result = await run(script!, 'status', row.app, remaining);
          row.running = typeof result.running === 'boolean' ? result.running : null;
        } catch { /* Unreadable status stays unknown; never echo stderr. */ }
        row.checkedAt = new Date(now()).toISOString();
      }
    }
    await Promise.all([worker(), worker()]);
    return { v: 1, generatedAt, available: true, apps };
  }
  return async (ctx, req, res, path, method) => {
    if (path === PATH && method === 'GET') {
      if (!cached || now() - cached.at >= 30_000) cached = { at: now(), view: snapshot() };
      try { sendJson(res, 200, await cached.view); }
      catch { sendJson(res, 503, { error: 'fleet apps unavailable' }); }
      return true;
    }
    if (path !== `${PATH}/action`) return false;
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '') || req.headers['x-ashlr-channel'] === 'mobile') {
      sendJson(res, 403, { error: 'local request required' }); return true;
    }
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { body = null; }
    if (!record(body) || Object.keys(body).some(k => k !== 'app' && k !== 'action') ||
      !FLEET_APPS.some(app => app === body.app) || (typeof body.action !== 'string' || !['launch', 'focus', 'restart'].includes(body.action))) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid app action' }); return true;
    }
    const script = locate();
    if (!script) { sendJson(res, 503, { error: 'fleet apps unavailable' }); return true; }
    try {
      const result = await run(script, body.action as string, body.app as string, 30_000);
      if (typeof result.code !== 'string') throw new Error('unreadable result');
      sendJson(res, 202, { app: body.app, action: body.action, code: result.code, at: new Date(now()).toISOString() });
    } catch { sendJson(res, 503, { error: 'fleet apps unavailable' }); }
    finally { cached = undefined; }
    return true;
  };
}
export const handleFleetAppsApi: ApiModule = createFleetAppsApi();
