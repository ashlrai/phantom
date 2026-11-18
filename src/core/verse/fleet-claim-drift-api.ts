/** Read-only claim-store drift under the runtime-identity prefix: whether the
 * bus work-claims table and the coordination lease table agree about who owns
 * what. Never writes, locks or repairs; a throwing reader degrades to an
 * UNKNOWN verdict with no error text. Fencing tokens are never in a row. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import {
  CLAIM_DRIFT_SCHEMA,
  readClaimStoreDrift,
  type ClaimDriftRow,
  type ClaimStoreDrift,
} from '../fleet/claim-store-drift.js';

export const VERSE_FLEET_CLAIM_DRIFT_PATH = '/api/verse/fleet/runtime-identity/claim-drift';
export const CLAIM_DRIFT_FIELD_CAP = 200;

export interface FleetClaimDriftResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  drift: ClaimStoreDrift;
}

export interface FleetClaimDriftApiDeps {
  /** Reader seam for tests. Default: readClaimStoreDrift(). */
  read?: () => ClaimStoreDrift;
  /** Clock seam for tests; stamps generatedAt and a degraded verdict's asOf. */
  now?: () => Date;
}

const cap = (s: string): string => (s.length > CLAIM_DRIFT_FIELD_CAP ? s.slice(0, CLAIM_DRIFT_FIELD_CAP) : s);

function capRow(row: ClaimDriftRow): ClaimDriftRow {
  const out: ClaimDriftRow = { ...row, id: cap(row.id), owner: cap(row.owner) };
  if (typeof row.busOwner === 'string') out.busOwner = cap(row.busOwner);
  if (typeof row.coordOwner === 'string') out.coordOwner = cap(row.coordOwner);
  if (typeof row.sourceId === 'string') out.sourceId = cap(row.sourceId);
  return out;
}

function capDrift(d: ClaimStoreDrift): ClaimStoreDrift {
  return {
    ...d,
    busOnly: d.busOnly.map(capRow),
    coordOnly: d.coordOnly.map(capRow),
    ownerMismatch: d.ownerMismatch.map(capRow),
  };
}

/** Both sources unreadable; carries no thrown message. */
function unknownDrift(asOf: string): ClaimStoreDrift {
  return {
    schema: CLAIM_DRIFT_SCHEMA, asOf, bus: 'unavailable', coordination: 'unavailable',
    matched: 0, busOnly: [], coordOnly: [], ownerMismatch: [],
    state: 'UNKNOWN', missing: ['bus', 'coordination'],
  };
}

export function createFleetClaimDriftApi(deps: FleetClaimDriftApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const read = deps.read ?? (() => readClaimStoreDrift());
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_CLAIM_DRIFT_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    // The router already stripped the query from `path`; read it from req.url.
    const params = new URL(req.url ?? '', 'http://local').searchParams;
    if ([...params.keys()].length > 0) {
      sendJson(res, 400, { v: 1, authority: 'none', error: 'no query accepted' });
      return true;
    }
    const generatedAt = now().toISOString();
    let drift: ClaimStoreDrift;
    try {
      drift = capDrift(read());
    } catch {
      drift = unknownDrift(generatedAt);
    }
    const response: FleetClaimDriftResponse = { v: 1, authority: 'none', generatedAt, drift };
    sendJson(res, 200, response);
    return true;
  };
}

export const handleFleetClaimDriftApi: ApiModule = createFleetClaimDriftApi();
