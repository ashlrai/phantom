/**
 * core/verse/fleet-board-api.ts — `GET /api/verse/fleet/board` (mounted by
 * verse-api.ts through the api-modules.ts contract).
 *
 * The Leader-as-CEO board the last Leader tick recorded at
 * `<runs>/coordination/leader-board.json`, read fresh each call through
 * core/fleet/fleet-board-read.ts — the same state file `phm fleet board`
 * reads, returned in the same `{schema, status, ageSeconds, board}` envelope
 * `phm fleet board --json` prints. Lanes, queue depth by tier, merges in the
 * last hour, the conflicting-PR trend and what is blocked on Mason.
 *
 *   GET /api/verse/fleet/board → FleetBoardResponse
 *   any other method on the path → 405
 *   any other path               → false (next module runs)
 *
 * A missing board answers 200 with `status:'missing'` and `board:null` — no
 * tick has recorded one yet is a fact about the fleet, not an HTTP error.
 * Read-only: no dispatch gate, no mutation surface; the board carries lane
 * names, counts, timestamps and the already-scrubbed needs-Mason lines only.
 */
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import {
  defaultFleetBoardRunsDir,
  fleetBoardResponse,
  readFleetBoard,
  type FleetBoardRead,
} from '../fleet/fleet-board-read.js';

export const VERSE_FLEET_BOARD_PATH = '/api/verse/fleet/board';

export interface FleetBoardApiDeps {
  /** Board reader; injectable so tests never touch a real runs dir. */
  readBoard?: (opts: { runsDir?: string }) => Promise<FleetBoardRead>;
  /** Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  /** Clock seam for tests; drives ageSeconds. */
  now?: () => number;
}

export function createFleetBoardApi(deps: FleetBoardApiDeps = {}): ApiModule {
  const read = deps.readBoard ?? readFleetBoard;
  const now = deps.now ?? Date.now;
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_BOARD_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    const unknown = [...new URL(req.url ?? '/', 'http://localhost').searchParams.keys()][0];
    if (unknown !== undefined) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` });
      return true;
    }
    let result: FleetBoardRead;
    try {
      result = await read({ runsDir: deps.runsDir ?? defaultFleetBoardRunsDir() });
    } catch {
      result = { status: 'unavailable', board: null };
    }
    sendJson(res, 200, fleetBoardResponse(result, now()));
    return true;
  };
}

export const handleFleetBoardApi: ApiModule = createFleetBoardApi();
