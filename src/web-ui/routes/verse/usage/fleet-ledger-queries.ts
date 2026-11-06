import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isResourceLedger, type ResourceLedgerV1 } from './fleet-ledger-model.js';

export const fleetLedgerQuery: QueryDef<ResourceLedgerV1 | null> = {
  key: 'verse-fleet-ledger',
  fetch: async (signal) => {
    try {
      const raw = await apiGet<unknown>('/api/verse/leader/resources', signal);
      if (!isResourceLedger(raw)) throw new Error('Invalid resource ledger response');
      return raw;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
