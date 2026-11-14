/** Desktop surface for the single authoritative fleet verdict: the same
 * readFleetRecheck() result `ashlr fleet recheck` and the Slack reply use, so
 * the desktop strip need not re-derive REACHABLE/BLOCKED client-side.
 * `?history=N` (1..50) adds the retained rows via readRecheckRecords.
 * POST `/record` runs the same read-only recheck and appends one sanitized
 * row to the local recheck log — the same write `ashlr fleet recheck-record`
 * performs, one in flight per process. It still sends nothing and grants no
 * authority; the only write is the existing local recheck log. */
import { homedir } from 'node:os';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { ashlrHome } from '../cloud/store.js';
import { readFleetRecheck, type FleetRecheck } from '../fleet/fleet-recheck.js';
import { appendRecheckRecord, readRecheckRecords, type AppendResult } from '../fleet/recheck-record.js';

export const VERSE_FLEET_RECHECK_PATH = '/api/verse/fleet/recheck';
const HISTORY_MAX = 50;

export interface FleetRecheckApiDeps {
  /** Verdict reader seam for tests. Default: readFleetRecheck(). */
  readRecheck?: () => FleetRecheck | Promise<FleetRecheck>;
  /** Ashlr home seam for tests. Default: ashlrHome(), read per request. */
  home?: () => string;
  /** Log-append seam for tests. Default: appendRecheckRecord(). */
  appendRecord?: (root: string, recheck: FleetRecheck, home: string) => AppendResult;
  /** Real-home seam for the row sanitizer. Default: os.homedir(). */
  homeDir?: () => string;
}

/** One record in flight per process: a second POST while one runs is a 409,
 * so two desktop clicks cannot double-append the same verdict. */
let recordInFlight = false;

export function createFleetRecheckApi(deps: FleetRecheckApiDeps = {}): ApiModule {
  const readRecheck = deps.readRecheck ?? (() => readFleetRecheck());
  const home = deps.home ?? ashlrHome;
  const appendRecord = deps.appendRecord ?? appendRecheckRecord;
  const homeDir = deps.homeDir ?? homedir;
  return async (_ctx, req, res, path, method) => {
    if (path === `${VERSE_FLEET_RECHECK_PATH}/record`) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      if (recordInFlight) {
        sendJson(res, 409, { error: 'recheck already running' });
        return true;
      }
      recordInFlight = true;
      try {
        let recheck: FleetRecheck;
        try {
          recheck = await readRecheck();
        } catch {
          sendJson(res, 503, { error: 'recheck unavailable' });
          return true;
        }
        const appended = appendRecord(home(), recheck, homeDir());
        if (!appended.ok) {
          sendJson(res, 500, { error: 'record failed', reason: appended.reason });
          return true;
        }
        sendJson(res, 200, { recorded: { overall: appended.record.overall, asOf: appended.record.asOf } });
        return true;
      } finally {
        recordInFlight = false;
      }
    }
    if (path !== VERSE_FLEET_RECHECK_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const raw = new URL(req.url ?? path, 'http://localhost').searchParams.get('history');
    let last: number | null = null;
    if (raw !== null) {
      last = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(last >= 1 && last <= HISTORY_MAX)) {
        sendJson(res, 400, { error: 'history must be 1..50' });
        return true;
      }
    }
    let recheck: FleetRecheck;
    try {
      recheck = await readRecheck();
    } catch {
      sendJson(res, 503, { error: 'recheck unavailable' });
      return true;
    }
    if (last === null) {
      sendJson(res, 200, { recheck });
      return true;
    }
    const { rows, skipped, missing } = readRecheckRecords(home(), last);
    sendJson(res, 200, { recheck, history: { rows, skipped, missing } });
    return true;
  };
}

export const handleFleetRecheckApi: ApiModule = createFleetRecheckApi();
