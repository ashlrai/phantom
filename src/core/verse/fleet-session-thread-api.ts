/**
 * GET /api/verse/fleet/control/session-thread?id=<session id>[&depth=full]: one
 * session as a conversation, the fleet.session-thread.v1 document behind
 * `phm sessions thread <id>` (core/fleet/session-thread.ts joins it).
 * `depth=full` is `--all`: more of the same records, no other source.
 *
 * Read only, and it needs a current read session like the session list. The
 * session map is shared for 5 seconds across callers and the order trace for
 * 15; the activity, bus and leader-reply reads happen only for a session the
 * list holds.
 *
 *   200 the thread · 400 bad query · 401 no read session · 404 no such session
 *   405 not GET · 503 the session list could not be read
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readOrderTrace, type OrderTraceV1 } from '../fleet/order-trace.js';
import type { FleetSessionMap } from '../fleet/sessions-view.js';
import { SESSION_ID_RE, SESSION_THREAD_DEPTHS, type SessionThreadDepth, type SessionThreadV1 } from '../fleet/session-thread.js';
import { readSessionThread } from '../fleet/session-thread-read.js';
import { throttledLiveMap } from './fleet-live-map-api.js';

export const SESSION_THREAD_PATH = '/api/verse/fleet/control/session-thread';
const ORDER_TRACE_MIN_INTERVAL_MS = 15_000;

/** `depth` is passed only when the caller asked for `full`. */
export type SessionThreadRead = (id: string, depth?: SessionThreadDepth) => Promise<SessionThreadV1>;

/** The default read: one throttled session map, then that session's own records. */
export function defaultSessionThreadRead(): SessionThreadRead {
  const map = throttledLiveMap<FleetSessionMap>(async () => (await import('../fleet/sessions-view.js')).readFleetSessionMap());
  // An open thread is polled every few seconds; the trace walks every job prompt, so callers share one reading.
  const orders = throttledLiveMap<OrderTraceV1>(() => readOrderTrace(), Date.now, ORDER_TRACE_MIN_INTERVAL_MS);
  return (id, depth) => readSessionThread(id, { depth, readMap: () => map(), readOrders: () => orders() });
}

export function createFleetSessionThreadApi(read: SessionThreadRead = defaultSessionThreadRead()): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== SESSION_THREAD_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const ids = params.getAll('id'), depths = params.getAll('depth');
    if ([...params.keys()].some(key => key !== 'id' && key !== 'depth') || ids.length !== 1 || !SESSION_ID_RE.test(ids[0]!)
      || depths.length > 1 || (depths.length === 1 && !SESSION_THREAD_DEPTHS.includes(depths[0] as SessionThreadDepth))) {
      sendJson(res, 400, { error: 'Use id=<session id> once: leader, a job id or a subagent id. depth is recent or full, at most once.' }); return true;
    }
    try {
      const thread = depths[0] === 'full' ? await read(ids[0]!, 'full') : await read(ids[0]!);
      if (thread.session) sendJson(res, 200, thread);
      else if (thread.sources.sessions === 'unavailable') sendJson(res, 503, { error: 'Sessions unavailable.' });
      else sendJson(res, 404, { error: thread.gaps[0] ?? 'No such session.' });
    } catch { sendJson(res, 503, { error: 'Session thread unavailable.' }); }
    return true;
  };
}
export const handleFleetSessionThreadApi = createFleetSessionThreadApi();
