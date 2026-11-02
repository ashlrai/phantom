/**
 * core/verse/main-health-api.ts — `GET /api/verse/runs-history/main-health`
 * (mounted by verse-api.ts through the api-modules.ts contract).
 *
 * The main guardian's verdict, read fresh each call from
 * `supervisor/status-main-guardian.md` under the runs dir
 * (core/fleet/main-health-read.ts): per-repo mainline state, the kill
 * switch, and staleness. The desktop fleet row's `mainHealthQuery` fetches
 * exactly this shape — a red repo with no fix job becomes the urgent
 * FleetNeedsYou item.
 *
 *   GET /api/verse/runs-history/main-health → MainHealthData
 *   any other method on the path            → 405
 *   any other path                          → false (next module runs)
 *
 * A thrown reader answers 200 with `source: 'unavailable'` — like the
 * lane-truth route, half-evidence is never health. Read-only: no dispatch
 * gate, no mutation surface; the response carries repo ids, check names and
 * timestamps only — never paths or error text (home paths are nulled by the
 * reader).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { readMainHealth, type MainHealthData } from '../fleet/main-health-read.js';

export const VERSE_RUNS_HISTORY_MAIN_HEALTH_PATH = '/api/verse/runs-history/main-health';

export interface MainHealthApiDeps {
  /** Defaults to readMainHealth on the resolved runs dir ($ASHLR_RUNS_DIR, then ~/.ashlr-runs). */
  read?: () => Promise<MainHealthData>;
}

const unavailable = (): MainHealthData => ({
  v: 1, generatedAt: new Date().toISOString(), source: 'unavailable',
  statusAt: null, stale: false, guardianOff: false, red: 0, repos: [],
});

export function createMainHealthApi(deps: MainHealthApiDeps = {}): ApiModule {
  const read = deps.read ?? (() => readMainHealth({}));
  return async (_ctx, req: IncomingMessage, res: ServerResponse, path, method) => {
    if (path !== VERSE_RUNS_HISTORY_MAIN_HEALTH_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    const unknown = [...new URL(req.url ?? '/', 'http://localhost').searchParams.keys()][0];
    if (unknown !== undefined) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` });
      return true;
    }
    try {
      sendJson(res, 200, await read());
    } catch {
      sendJson(res, 200, unavailable());
    }
    return true;
  };
}

export const handleMainHealthApi: ApiModule = createMainHealthApi();
