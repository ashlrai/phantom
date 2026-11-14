/** Desktop surface for who has claimed what: a read-only view of the advisory
 * coordination ledger (fleet.coordination.v1). Returns claims only; message
 * bodies, proposals and lease material never leave this module. The route
 * takes no query, path or root input. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readFleetBoard, type FleetBoard } from '../fleet/coordination.js';

export const VERSE_FLEET_COORDINATION_CLAIMS_PATH = '/api/verse/fleet/coordination-claims';

const MAX_CLAIMS = 50;
const MAX_TASK_CHARS = 200;

export interface FleetCoordinationClaimsApiDeps {
  /** Reader seam for tests. Default: readFleetBoard(). */
  read?: () => FleetBoard;
  /** Clock seam for tests; stamps generatedAt and expiresInSeconds. */
  now?: () => Date;
}

export interface FleetClaimView {
  id: string; repo: string; task: string; agent: string;
  claimedAt: string; expiresAt: string; expiresInSeconds: number;
}

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown';
}

export function createFleetCoordinationClaimsApi(deps: FleetCoordinationClaimsApiDeps = {}): ApiModule {
  const read = deps.read ?? (() => readFleetBoard());
  const now = deps.now ?? (() => new Date());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_COORDINATION_CLAIMS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const at = now();
    const base = { v: 1, generatedAt: at.toISOString(), source: 'coordination-ledger' };
    let board: FleetBoard;
    try {
      board = read();
    } catch {
      sendJson(res, 200, { ...base, state: 'unknown', claims: [], expiredClaims: null, reason: 'coordination ledger: reader failed' });
      return true;
    }
    const claims: FleetClaimView[] = [...board.claims]
      .sort((a, b) => b.claimedAt - a.claimedAt)
      .slice(0, MAX_CLAIMS)
      .map(c => ({
        id: c.id, repo: c.repo, task: String(c.task).slice(0, MAX_TASK_CHARS), agent: c.agent,
        claimedAt: iso(c.claimedAt), expiresAt: iso(c.expiresAt),
        expiresInSeconds: Math.round((c.expiresAt - at.getTime()) / 1000),
      }));
    sendJson(res, 200, { ...base, state: board.state, claims, expiredClaims: board.expiredClaims });
    return true;
  };
}

export const handleFleetCoordinationClaimsApi: ApiModule = createFleetCoordinationClaimsApi();
