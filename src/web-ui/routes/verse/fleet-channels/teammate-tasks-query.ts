import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowTeammateTasks, type TeammateTasksView } from './teammate-tasks-model.js';

/** `null` = this build has no route (404) or the payload did not parse. */
export const teammateTasksQuery: QueryDef<TeammateTasksView | null> = {
  key: 'verse-fleet-teammate-tasks',
  async fetch(signal) {
    try { return narrowTeammateTasks(await apiGet<unknown>('/api/verse/fleet/control/teammate-tasks', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
