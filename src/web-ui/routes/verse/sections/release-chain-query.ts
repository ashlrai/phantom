import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { ReleaseChainStatus } from '../../../../core/fleet/release-chain-status.js';

export const releaseChainQuery: QueryDef<ReleaseChainStatus | null> = {
  key: 'fleet-release-chain',
  async fetch(signal) {
    try { return await apiGet<ReleaseChainStatus>('/api/fleet/release-chain', signal); }
    catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
      throw error;
    }
  },
};
