import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { readLeaderPulse, type LeaderPulseInput } from './leader-pulse-model.js';

export function createLeaderPulseQuery(): { query: QueryDef<LeaderPulseInput>; resetMissing: () => void } {
  let missing: ApiError | null = null;
  let generation = 0;
  return {
    resetMissing: () => { missing = null; generation += 1; },
    query: {
      key: 'verse-leader-pulse',
      async fetch(signal) {
        if (missing) throw missing;
        const issued = generation;
        try {
          const value = readLeaderPulse(await apiGet<unknown>('/api/verse/fleet/runs', signal));
          if (!value) throw new Error('Invalid fleet runs snapshot.');
          return value;
        } catch (error) {
          if (issued === generation && error instanceof ApiError && error.status === 404) missing = error;
          throw error;
        }
      },
    },
  };
}
