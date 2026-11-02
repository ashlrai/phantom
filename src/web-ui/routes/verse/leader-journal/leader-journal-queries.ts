import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isLeaderJournal, type LeaderJournalV1 } from './leader-journal-model.js';

export const leaderJournalQuery: QueryDef<LeaderJournalV1 | null> = {
  key: 'verse-leader-journal',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/ops/leader-journal', signal);
      if (!isLeaderJournal(value)) throw new Error('Invalid leader journal response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
