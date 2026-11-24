/** Desktop route for agents' VERIFIED/BLOCKED result receipts: a read-only
 * projection of the advisory coordination ledger. Takes no query, path or
 * root input, never writes, and never sends a thrown message. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readFleetBoard, type FleetBoard } from '../fleet/coordination.js';
import { projectCoordinationReturns } from '../fleet/coordination-returns-view.js';

export const VERSE_FLEET_COORDINATION_RETURNS_PATH = '/api/verse/fleet/coordination-claims/returns';

export interface FleetCoordinationReturnsApiDeps {
  /** Reader seam for tests. Default reads retained returns at the route clock without reaping. */
  read?: () => FleetBoard;
  /** Clock seam for tests. */
  now?: () => Date;
}

export function createFleetCoordinationReturnsApi(deps: FleetCoordinationReturnsApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_COORDINATION_RETURNS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const at = now();
    let board: FleetBoard | null;
    try { board = deps.read ? deps.read() : readFleetBoard({ now: at.getTime(), reap: false, includeExpiredReturns: true }); } catch { board = null; }
    const body = { ...projectCoordinationReturns(board, at.getTime()), authority: 'none' as const, generatedAt: at.toISOString() };
    // Round-trip through JSON so each row's non-enumerable toJSON runs before any sanitizer.
    sendJson(res, 200, JSON.parse(JSON.stringify(body)));
    return true;
  };
}

export const handleFleetCoordinationReturnsApi: ApiModule = createFleetCoordinationReturnsApi();
