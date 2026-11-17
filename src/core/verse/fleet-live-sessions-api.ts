/**
 * GET /api/verse/fleet/control/live-sessions[?lane=L][&repo=R]: the
 * fleet.live-sessions.v1 list behind `phm sessions` and the desktop Sessions
 * pane. Reads only the session map the Compute map already reads
 * (core/fleet/live-sessions.ts projects it).
 *
 * One session-map read serves every caller for 5 seconds (the Map's throttle);
 * filters apply to that shared read, so polling panes and agents cost at most
 * one fleet read per 5 s.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import type { FleetSessionMap } from '../fleet/sessions-view.js';
import { SESSION_FILTER_RE, type LiveSessionsV1 } from '../fleet/live-sessions.js';
import { readLiveSessions } from '../fleet/live-sessions-read.js';
import { throttledLiveMap } from './fleet-live-map-api.js';

export const LIVE_SESSIONS_PATH = '/api/verse/fleet/control/live-sessions';

export type LiveSessionsRead = (filter: { lane: string | null; repo: string | null }) => Promise<LiveSessionsV1>;

/** The default read: one throttled session map, filtered per request. */
export function defaultLiveSessionsRead(): LiveSessionsRead {
  const map = throttledLiveMap<FleetSessionMap>(async () => (await import('../fleet/sessions-view.js')).readFleetSessionMap());
  return filter => readLiveSessions({ ...filter, readMap: () => map() });
}

export function createFleetLiveSessionsApi(read: LiveSessionsRead = defaultLiveSessionsRead()): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== LIVE_SESSIONS_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const one = (key: string) => (params.getAll(key).length > 1 ? undefined : params.get(key));
    const lane = one('lane'), repo = one('repo');
    if ([...params.keys()].some(key => key !== 'lane' && key !== 'repo') || lane === undefined || repo === undefined
      || (lane !== null && !SESSION_FILTER_RE.test(lane)) || (repo !== null && !SESSION_FILTER_RE.test(repo))) {
      sendJson(res, 400, { error: 'Use lane=<lane> and repo=<repo> only, once each.' }); return true;
    }
    try { sendJson(res, 200, await read({ lane, repo })); }
    catch { sendJson(res, 503, { error: 'Sessions unavailable.' }); }
    return true;
  };
}
export const handleFleetLiveSessionsApi = createFleetLiveSessionsApi();
