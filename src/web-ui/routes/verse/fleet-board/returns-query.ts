import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { parseReturns, type ParsedReturns } from './returns-model.js';

export const returnsQuery: QueryDef<ParsedReturns | null> = {
  key: 'verse-fleet-coordination-returns',
  async fetch(signal) {
    try {
      return parseReturns(await apiGet<unknown>('/api/verse/fleet/coordination-claims/returns', signal));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
