import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Kept local to the web bundle; `check` is narrowed at the display boundary by parseBridgeCheck. */
export interface BridgeCheckResponse {
  v: 1;
  authority: 'none';
  check: unknown;
}

export const bridgeCheckQuery: QueryDef<BridgeCheckResponse | null> = {
  key: 'verse-fleet-bridge-check',
  async fetch(signal) {
    try {
      return await apiGet<BridgeCheckResponse>('/api/verse/fleet/runtime-identity/bridge-check', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
