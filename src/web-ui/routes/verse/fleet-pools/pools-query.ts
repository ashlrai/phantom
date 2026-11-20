/** GET /api/app/pools as a cached query, shared by the desktop Pools pane and the phone Home card. */
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
    return { ...data, pools: data.pools.map(row => ({ ...row, running: row.running ?? null, burn: row.burn ?? { samples: 0, window_h: 0, method: 'none' as const }, projectedEmptyAt: row.projectedEmptyAt ?? null, verdict: row.verdict ?? 'unknown' as const, target: row.target ?? null, source: row.source ?? null, scopes: Array.isArray(row.scopes) ? row.scopes : [], modelCaps: Array.isArray(row.modelCaps) ? row.modelCaps : [] })) };
  },
};
