/**
 * routes/verse/fleet-pools/pools-query.ts — the one read of GET /api/app/pools (pools.v1, the view `phm pools`
 * prints). It lives outside the pane so the resource board switcher can show the Pools reading without loading
 * the board itself; both share the 'app-pools' cache entry.
 */
import { POOLS_PATH, POOLS_SCHEMA, type PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const fleetPoolsQuery: QueryDef<PoolsViewV1> = {
  key: 'app-pools',
  fetch: async signal => {
    const data = await apiGet<PoolsViewV1>(POOLS_PATH, signal);
    // A drifted payload is loud, not a blank list.
    if (data?.schema !== POOLS_SCHEMA || !Array.isArray(data.pools)) throw new Error(`Expected ${POOLS_SCHEMA}`);
    // An older server sends rows without the newer fields: absent is unknown (or none), never a number.
    return { ...data, pools: data.pools.map(row => ({ ...row, running: row.running ?? null, target: row.target ?? null, source: row.source ?? null, scopes: Array.isArray(row.scopes) ? row.scopes : [] })) };
  },
};
