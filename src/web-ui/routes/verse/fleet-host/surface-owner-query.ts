import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Kept local to the web bundle; the report is narrowed at the display boundary. */
export interface SurfaceOwnerResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  surfaces: unknown;
}

export const surfaceOwnerQuery: QueryDef<SurfaceOwnerResponse | null> = {
  key: 'verse-fleet-surface-owner',
  async fetch(signal) {
    try {
      return await apiGet<SurfaceOwnerResponse>('/api/verse/fleet/runtime-identity/surface-owner', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
