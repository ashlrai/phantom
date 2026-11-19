/**
 * GET /api/verse/fleet/control/session-threads[?lane=L][&repo=R][&live=1]:
 * every agent session as a short conversation, the fleet.session-threads.v1
 * document behind `phm sessions threads` (core/fleet/session-threads.ts joins
 * it). One request for a screen that shows every session at once.
 *
 * Read only, and it needs a current read session like the session list. One
 * build per filter serves every caller for 5 seconds, and callers that arrive
 * while it is running share it, so polling panes cost one fleet read per 5 s.
 * The order trace behind the routing lines is shared across filters for 15 s.
 *
 *   200 the threads · 400 bad query · 401 no read session · 405 not GET
 *   503 the session list could not be read
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { SESSION_FILTER_RE } from '../fleet/live-sessions.js';
import { readLeaderSessionFacts } from '../fleet/live-sessions-read.js';
import { readOrderTrace, type OrderTraceV1 } from '../fleet/order-trace.js';
import type { LeaderSessionFacts } from '../fleet/session-tree.js';
import type { SessionThreadsV1 } from '../fleet/session-threads.js';
import { readSessionThreads } from '../fleet/session-threads-read.js';
import { throttledLiveMap } from './fleet-live-map-api.js';

export const SESSION_THREADS_PATH = '/api/verse/fleet/control/session-threads';
const LEADER_FACTS_MIN_INTERVAL_MS = 15_000;
/** The trace reads job prompts off disk; the Leader pane's own orders read polls no faster. */
const ORDER_TRACE_MIN_INTERVAL_MS = 15_000;
/** Filters are caller text, so the per-filter builds kept are bounded. */
const FILTERS_KEPT = 16;

export type SessionThreadsFilter = { lane: string | null; repo: string | null; live?: boolean };
export type SessionThreadsRead = (filter: SessionThreadsFilter) => Promise<SessionThreadsV1>;

/** The default read: one throttled build per filter. */
export function defaultSessionThreadsRead(): SessionThreadsRead {
  const leader = throttledLiveMap<LeaderSessionFacts>(() => readLeaderSessionFacts(), Date.now, LEADER_FACTS_MIN_INTERVAL_MS);
  const orders = throttledLiveMap<OrderTraceV1>(() => readOrderTrace(), Date.now, ORDER_TRACE_MIN_INTERVAL_MS);
  const builds = new Map<string, () => Promise<SessionThreadsV1>>();
  return filter => {
    const key = JSON.stringify([filter.lane, filter.repo, filter.live === true]);
    let build = builds.get(key);
    if (!build) {
      if (builds.size >= FILTERS_KEPT) builds.clear();
      build = throttledLiveMap<SessionThreadsV1>(() => readSessionThreads({ ...filter, readLeader: () => leader(), readOrders: () => orders() }));
      builds.set(key, build);
    }
    return build();
  };
}

export function createFleetSessionThreadsApi(read: SessionThreadsRead = defaultSessionThreadsRead()): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== SESSION_THREADS_PATH) return false;
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
    try {
      const threads = await read({ lane, repo, ...(live ? { live: true } : {}) });
      if (threads.sources.sessions === 'unavailable') sendJson(res, 503, { error: 'Sessions unavailable.' });
      else sendJson(res, 200, threads);
    } catch { sendJson(res, 503, { error: 'Session threads unavailable.' }); }
    return true;
  };
}
export const handleFleetSessionThreadsApi = createFleetSessionThreadsApi();
