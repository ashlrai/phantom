/** GET /api/verse/leader/resources/usage-history as a cached query: every pool's stored readings of its current window, the data `phm fleet usage-history --json` prints. */
import type { UsageHistoryV1 } from '../../../../core/fleet/usage-history.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

// Written out, not imported: core/fleet/usage-history.ts reads files, so only its types may reach the browser bundle.
export const POOL_WINDOWS_PATH = '/api/verse/leader/resources/usage-history';
const SCHEMA: UsageHistoryV1['schema'] = 'fleet.usage-history.v1';

export const poolWindowsQuery: QueryDef<UsageHistoryV1> = {
  key: 'pool-usage-history',
  fetch: async signal => {
    const data = await apiGet<UsageHistoryV1>(POOL_WINDOWS_PATH, signal);
    // A drifted payload is a failed read, not a board of pools without readings.
    if (data?.schema !== SCHEMA || !Array.isArray(data.pools)) throw new Error(`Expected ${SCHEMA}`);
    return data;
  },
};
