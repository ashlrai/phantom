import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Kept local to the web bundle; the report is narrowed at the display boundary. */
export interface ClaimExecutionResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  report: unknown;
}

export const claimExecutionQuery: QueryDef<ClaimExecutionResponse | null> = {
  key: 'verse-fleet-claim-execution',
  async fetch(signal) {
    try {
      return await apiGet<ClaimExecutionResponse>('/api/verse/fleet/runtime-identity/claim-execution', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
