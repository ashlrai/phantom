import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isFleetQueue, type FleetQueueV1 } from './ops-queue-model.js';

export const opsQueueQuery: QueryDef<FleetQueueV1 | null> = {
  key: 'verse-fleet-queue',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/fleet/live/queue?limit=25', signal);
      if (!isFleetQueue(value)) throw new Error('Invalid queue response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
