import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowClaimNotices, type ClaimNoticesView } from './claim-notices-model.js';

/** `null` = this build has no route (404) or the payload did not parse. */
export const claimNoticesQuery: QueryDef<ClaimNoticesView | null> = {
  key: 'verse-fleet-claim-notices',
  async fetch(signal) {
    try { return narrowClaimNotices(await apiGet<unknown>('/api/verse/fleet/control/claim-notices', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
