import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isResourceLedger, type ResourceLedgerV1 } from '../usage/fleet-ledger-model.js';

/** Remember a missing endpoint for this pane visit, without suppressing other errors. */
export function supplyLedgerQuery(): QueryDef<ResourceLedgerV1 | null> {
  let missing = false;
  return {
    key: 'verse-supply-ledger',
    fetch: async signal => {
      if (missing) return null;
      try {
        const data = await apiGet<unknown>('/api/verse/leader/resources', signal);
        if (!isResourceLedger(data)) throw new Error('Invalid resource ledger response');
        return data;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) { missing = true; return null; }
        throw error;
      }
    },
  };
}
