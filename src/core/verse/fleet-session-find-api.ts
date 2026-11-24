/**
 * GET /api/verse/fleet/control/session-find?q=<words>[&lane=L][&repo=R][&live=1]:
 * the sessions whose whole conversation holds every word, the
 * fleet.session-find.v1 document behind `phm sessions find`
 * (core/fleet/session-find.ts joins it).
 *
 * Read only, and it needs a current read session like the session list. The
 * fleet is read at most once per filter per 5 seconds; every query in that
 * window searches the same read, so typing costs no extra file reads.
 *
 *   200 the results · 400 bad query · 401 no read session · 405 not GET
 *   503 the session list could not be read
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { SESSION_FILTER_RE } from '../fleet/live-sessions.js';
import { buildSessionFind, FIND_QUERY_CHARS, findWords, type SessionFindV1 } from '../fleet/session-find.js';
import { readSessionFindParts, type SessionThreadsPartsRead } from '../fleet/session-threads-read.js';
import { throttledLiveMap } from './fleet-live-map-api.js';

export const SESSION_FIND_PATH = '/api/verse/fleet/control/session-find';
/** Filters are caller text, so the per-filter reads kept are bounded. */
const FILTERS_KEPT = 16;

export type SessionFindFilter = { lane: string | null; repo: string | null; live?: boolean };
export type SessionFindRead = (words: readonly string[], filter: SessionFindFilter) => Promise<SessionFindV1>;

/** The default read: one throttled fleet read per filter, searched once per request. */
export function defaultSessionFindRead(readParts: (filter: SessionFindFilter) => Promise<SessionThreadsPartsRead> = filter => readSessionFindParts(filter)): SessionFindRead {
  const reads = new Map<string, () => Promise<SessionThreadsPartsRead>>();
  return async (words, filter) => {
    const key = JSON.stringify([filter.lane, filter.repo, filter.live === true]);
    let read = reads.get(key);
    if (!read) {
      if (reads.size >= FILTERS_KEPT) reads.clear();
      read = throttledLiveMap<SessionThreadsPartsRead>(() => readParts(filter));
      reads.set(key, read);
    }
    const { list, parts, now } = await read();
    return buildSessionFind(list, parts, words, now);
  };
}

export function createFleetSessionFindApi(read: SessionFindRead = defaultSessionFindRead()): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== SESSION_FIND_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const one = (key: string) => (params.getAll(key).length > 1 ? undefined : params.get(key));
    const q = one('q'), lane = one('lane'), repo = one('repo'), live = one('live');
    const words = typeof q === 'string' && q.length <= FIND_QUERY_CHARS ? findWords(q) : [];
    if ([...params.keys()].some(key => key !== 'q' && key !== 'lane' && key !== 'repo' && key !== 'live') || lane === undefined || repo === undefined
      || (lane !== null && !SESSION_FILTER_RE.test(lane)) || (repo !== null && !SESSION_FILTER_RE.test(repo)) || (live !== null && live !== '1') || words.length === 0) {
      sendJson(res, 400, { error: `Use q=<words> (a word is two characters or more, ${FIND_QUERY_CHARS} characters in all), then lane=<lane>, repo=<repo> and live=1 only, once each.` }); return true;
    }
    try {
      const found = await read(words, { lane, repo, ...(live ? { live: true } : {}) });
      if (found.sources.sessions === 'unavailable') sendJson(res, 503, { error: 'Sessions unavailable.' });
      else sendJson(res, 200, found);
    } catch { sendJson(res, 503, { error: 'Session search unavailable.' }); }
    return true;
  };
}
export const handleFleetSessionFindApi = createFleetSessionFindApi();
