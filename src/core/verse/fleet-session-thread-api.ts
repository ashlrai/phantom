/**
 * GET /api/verse/fleet/control/session-thread?id=<session id>: one session as a
 * conversation, the fleet.session-thread.v1 document behind
 * `phm sessions thread <id>` (core/fleet/session-thread.ts joins it).
 *
 * Read only, and it needs a current read session like the session list. The
 * session map is shared for 5 seconds across callers; the activity, bus and
 * leader-reply reads happen only for a session the list holds.
 *
 *   200 the thread · 400 bad query · 401 no read session · 404 no such session
 *   405 not GET · 503 the session list could not be read
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import type { FleetSessionMap } from '../fleet/sessions-view.js';
import { SESSION_ID_RE, type SessionThreadV1 } from '../fleet/session-thread.js';
import { readSessionThread } from '../fleet/session-thread-read.js';
import { throttledLiveMap } from './fleet-live-map-api.js';

export const SESSION_THREAD_PATH = '/api/verse/fleet/control/session-thread';

export type SessionThreadRead = (id: string) => Promise<SessionThreadV1>;

/** The default read: one throttled session map, then that session's own records. */
export function defaultSessionThreadRead(): SessionThreadRead {
  const map = throttledLiveMap<FleetSessionMap>(async () => (await import('../fleet/sessions-view.js')).readFleetSessionMap());
  return id => readSessionThread(id, { readMap: () => map() });
}

export function createFleetSessionThreadApi(read: SessionThreadRead = defaultSessionThreadRead()): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== SESSION_THREAD_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const ids = params.getAll('id');
    if ([...params.keys()].some(key => key !== 'id') || ids.length !== 1 || !SESSION_ID_RE.test(ids[0]!)) {
      sendJson(res, 400, { error: 'Use id=<session id> once: leader, a job id or a subagent id.' }); return true;
    }
    try {
      const thread = await read(ids[0]!);
      if (thread.session) sendJson(res, 200, thread);
      else if (thread.sources.sessions === 'unavailable') sendJson(res, 503, { error: 'Sessions unavailable.' });
      else sendJson(res, 404, { error: thread.gaps[0] ?? 'No such session.' });
    } catch { sendJson(res, 503, { error: 'Session thread unavailable.' }); }
    return true;
  };
}
export const handleFleetSessionThreadApi = createFleetSessionThreadApi();
