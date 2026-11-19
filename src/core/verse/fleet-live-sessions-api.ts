/**
 * GET /api/verse/fleet/control/live-sessions[?lane=L][&repo=R][&live=1]: the
 * fleet.live-sessions.v1 list behind `phm sessions` and the desktop Sessions
 * pane. Reads only the session map the Compute map already reads
 * (core/fleet/live-sessions.ts projects it).
 *
 * One session-map read serves every caller for 5 seconds (the Map's throttle);
 * filters apply to that shared read, so polling panes and agents cost at most
 * one fleet read per 5 s. The leader's row (its last pass and last reply, from
 * its plan log and outbox) is read at most once per 15 s: it changes per pass.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import type { FleetSessionMap } from '../fleet/sessions-view.js';
import { SESSION_FILTER_RE, type LiveSessionsV1 } from '../fleet/live-sessions.js';
import { readLeaderSessionFacts, readLiveSessions } from '../fleet/live-sessions-read.js';
import type { LeaderSessionFacts } from '../fleet/session-tree.js';
import { throttledLiveMap } from './fleet-live-map-api.js';

export const LIVE_SESSIONS_PATH = '/api/verse/fleet/control/live-sessions';
const LEADER_FACTS_MIN_INTERVAL_MS = 15_000;

export type LiveSessionsRead = (filter: { lane: string | null; repo: string | null; live?: boolean }) => Promise<LiveSessionsV1>;

/** The default read: one throttled session map, filtered per request. */
export function defaultLiveSessionsRead(): LiveSessionsRead {
  const map = throttledLiveMap<FleetSessionMap>(async () => (await import('../fleet/sessions-view.js')).readFleetSessionMap());
  const leader = throttledLiveMap<LeaderSessionFacts>(() => readLeaderSessionFacts(), Date.now, LEADER_FACTS_MIN_INTERVAL_MS);
  return filter => readLiveSessions({ ...filter, readMap: () => map(), readLeader: () => leader() });
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
    const lane = one('lane'), repo = one('repo'), live = one('live');
    if ([...params.keys()].some(key => key !== 'lane' && key !== 'repo' && key !== 'live') || lane === undefined || repo === undefined
      || (lane !== null && !SESSION_FILTER_RE.test(lane)) || (repo !== null && !SESSION_FILTER_RE.test(repo)) || (live !== null && live !== '1')) {
      sendJson(res, 400, { error: 'Use lane=<lane>, repo=<repo> and live=1 only, once each.' }); return true;
    }
    try { sendJson(res, 200, await read({ lane, repo, ...(live ? { live: true } : {}) })); }
    catch { sendJson(res, 503, { error: 'Sessions unavailable.' }); }
    return true;
  };
}
export const handleFleetLiveSessionsApi = createFleetLiveSessionsApi();
