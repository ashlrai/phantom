/** Desktop surface for the single authoritative fleet verdict: the same
 * readFleetRecheck() result `ashlr fleet recheck` and the Slack reply use, so
 * the desktop strip need not re-derive REACHABLE/BLOCKED client-side.
 * Read-only: never appends to the recheck log, never sends, grants nothing.
 * `?history=N` (1..50) adds the retained rows via readRecheckRecords. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { ashlrHome } from '../cloud/store.js';
import { readFleetRecheck, type FleetRecheck } from '../fleet/fleet-recheck.js';
import { readRecheckRecords } from '../fleet/recheck-record.js';

export const VERSE_FLEET_RECHECK_PATH = '/api/verse/fleet/recheck';
const HISTORY_MAX = 50;

export interface FleetRecheckApiDeps {
  /** Verdict reader seam for tests. Default: readFleetRecheck(). */
  readRecheck?: () => FleetRecheck | Promise<FleetRecheck>;
  /** Ashlr home seam for tests. Default: ashlrHome(), read per request. */
  home?: () => string;
}

export function createFleetRecheckApi(deps: FleetRecheckApiDeps = {}): ApiModule {
  const readRecheck = deps.readRecheck ?? (() => readFleetRecheck());
  const home = deps.home ?? ashlrHome;
  return async (_ctx, req, res, path, method) => {
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
