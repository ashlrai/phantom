import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { toOrchestrationView, type OrchestrationView } from './orchestration-model.js';

/** `null` = this build has no route (404) or the payload did not parse. */
export const orchestrationQuery: QueryDef<OrchestrationView | null> = {
  key: 'verse-fleet-orchestration',
  async fetch(signal) {
    try { return toOrchestrationView(await apiGet<unknown>('/api/verse/fleet/control/orchestration', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
