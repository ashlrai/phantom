/** Desktop surface for who has claimed what: a read-only view of the advisory
 * coordination ledger (fleet.coordination.v1). Returns claims only; message
 * bodies, proposals and lease material never leave this module. The route
 * takes no query, path or root input. POST /claim and /return sub-paths
 * chain to fleet-coordination-mutate-api.ts (advisory claim/return). */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readFleetBoard, type FleetBoard } from '../fleet/coordination.js';
import { projectCoordinationClaims } from '../fleet/coordination-claims-view.js';
import {
  VERSE_FLEET_COORDINATION_BIND_PATH, VERSE_FLEET_COORDINATION_CLAIM_PATH, VERSE_FLEET_COORDINATION_RETURN_PATH, handleFleetCoordinationMutateApi,
} from './fleet-coordination-mutate-api.js';
import { VERSE_FLEET_COORDINATION_RETURNS_PATH, handleFleetCoordinationReturnsApi } from './fleet-coordination-returns-api.js';

export const VERSE_FLEET_COORDINATION_CLAIMS_PATH = '/api/verse/fleet/coordination-claims';
/** Must equal VERSE_FLEET_COORDINATION_RETURNS_VERIFY_PATH; repeated here so the
 * module that shells out to gh loads only when its route is first requested. */
const RETURNS_VERIFY_PATH = '/api/verse/fleet/coordination-claims/returns/verify';
const lazyReturnsVerify: ApiModule = async (...args) =>
  (await import('./fleet-coordination-returns-verify-api.js')).handleFleetCoordinationReturnsVerifyApi(...args);

export interface FleetCoordinationClaimsApiDeps {
  /** Reader seam for tests. Default: readFleetBoard({ reap: false }). */
  read?: () => FleetBoard;
  /** Clock seam for tests; stamps generatedAt and expiresInSeconds. */
  now?: () => Date;
  /** Sub-path module for /claim and /return. Default: handleFleetCoordinationMutateApi. */
  mutate?: ApiModule;
  /** Module for the /returns sub-path. Default: handleFleetCoordinationReturnsApi. */
  returns?: ApiModule;
  /** Module for the /returns/verify sub-path. Default: handleFleetCoordinationReturnsVerifyApi, loaded lazily. */
  returnsVerify?: ApiModule;
}

export interface FleetClaimView {
  id: string; repo: string; task: string; agent: string;
  claimedAt: string; expiresAt: string; expiresInSeconds: number | null;
}

export function createFleetCoordinationClaimsApi(deps: FleetCoordinationClaimsApiDeps = {}): ApiModule {
  const read = deps.read ?? (() => readFleetBoard({ reap: false }));
  const now = deps.now ?? (() => new Date());
  const mutate = deps.mutate ?? handleFleetCoordinationMutateApi;
  const returns = deps.returns ?? handleFleetCoordinationReturnsApi;
  const returnsVerify = deps.returnsVerify ?? lazyReturnsVerify;
  return async (ctx, req, res, path, method) => {
    if (path === VERSE_FLEET_COORDINATION_CLAIM_PATH || path === VERSE_FLEET_COORDINATION_RETURN_PATH
      || path === VERSE_FLEET_COORDINATION_BIND_PATH) {
      return mutate(ctx, req, res, path, method);
    }
    if (path === RETURNS_VERIFY_PATH) return returnsVerify(ctx, req, res, path, method);
    if (path === VERSE_FLEET_COORDINATION_RETURNS_PATH) return returns(ctx, req, res, path, method);
    if (path !== VERSE_FLEET_COORDINATION_CLAIMS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const at = now();
    let board: FleetBoard | null;
    try {
      board = read();
    } catch {
      board = null;
    }
    const { v, asOf, ...view } = projectCoordinationClaims(board, at.getTime());
    sendJson(res, 200, { v, generatedAt: asOf, ...view });
    return true;
  };
}

export const handleFleetCoordinationClaimsApi: ApiModule = createFleetCoordinationClaimsApi();
