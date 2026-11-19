/**
 * core/verse/fleet-worklog-api.ts — `GET /api/verse/fleet/worklog[?hours=24][&repo=<r>]`.
 *
 * The same report `phm worklog --prs --json` prints (fleet.worklog-prs.v1): one
 * entry per merged PR, newest first, with jobs that ended with no PR counted per
 * hour. Read-only; `since=24h` is accepted as the older spelling of `hours=24`.
 * Bad hours or an unknown parameter → 400; an unreadable ledger → 200 with the
 * jobs source marked unknown, never an error body that hides what is known.
 */
import { readWorklog, worklogHours, WORKLOG_DEFAULT_HOURS, type WorklogReport } from '../fleet/worklog.js';
import { worklogPrs } from '../fleet/worklog-prs.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_WORKLOG_PATH = '/api/verse/fleet/worklog';
const MAX_HOURS = 168;

export function createFleetWorklogApi(read: (hours: number) => Promise<WorklogReport> = readWorklog): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_WORKLOG_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: `method not allowed: ${method} ${path}` }); return true; }
    const query = new URL(req.url ?? path, 'http://localhost').searchParams;
    const unknown = [...query.keys()].find(key => !['hours', 'since', 'repo'].includes(key));
    if (unknown !== undefined) { sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` }); return true; }
    let hours: number;
    try { hours = worklogHours(query.get('hours') ?? query.get('since') ?? String(WORKLOG_DEFAULT_HOURS * 4)); } catch { hours = NaN; }
    if (!(hours >= 1 && hours <= MAX_HOURS)) { sendJson(res, 400, { code: 'VERSE_INVALID', error: `hours must be 1 to ${MAX_HOURS}, for example 24.` }); return true; }
    const repo = query.get('repo') ?? undefined;
    if (repo !== undefined && !/^[A-Za-z0-9_.-]{1,100}(\/[A-Za-z0-9_.-]{1,100})?$/.test(repo)) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'repo must be a name or owner/name.' }); return true;
    }
    try { sendJson(res, 200, worklogPrs(await read(hours), repo)); }
    catch { sendJson(res, 503, { code: 'VERSE_UNAVAILABLE', error: 'The work log could not be read.' }); }
    return true;
  };
}

export const handleFleetWorklogApi: ApiModule = createFleetWorklogApi();
