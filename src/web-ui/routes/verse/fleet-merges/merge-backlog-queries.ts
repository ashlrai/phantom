import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';

export const mergeBacklogQuery: QueryDef<MergeBacklogReadV1> = {
  key: 'verse-merges-backlog-phantom',
  fetch: async signal => {
    try { return await apiGet<MergeBacklogReadV1>('/api/verse/github/fleet-backlog?repo=ashlrai%2Fphantom', signal); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 503) throw error;
      return { v: 1, repo: 'ashlrai/phantom', generatedAt: '', source: 'gh-failed', reason: error.detail ?? 'gh-pr-list-failed', items: [], counts: { mergeState: {}, actions: { merge: 0, recut: 0, refresh: 0, wait: 0, none: 0 } } };
    }
  },
};
