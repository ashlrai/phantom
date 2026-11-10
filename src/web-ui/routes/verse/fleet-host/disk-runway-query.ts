import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowDiskRunway, type DiskRunwayView } from './disk-runway-model.js';

export const diskRunwayQuery: QueryDef<DiskRunwayView | null> = {
  key: 'verse-fleet-disk-forecast',
  async fetch(signal) {
    try { return narrowDiskRunway(await apiGet<unknown>('/api/verse/fleet/disk-forecast', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
