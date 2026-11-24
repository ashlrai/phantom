import type { MasonThread } from '../../../../core/comms/mason-thread-model.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** The same data as `phm mason thread --json`; read-only. */
export const masonThreadQuery: QueryDef<MasonThread> = {
  key: 'verse-mason-thread',
  fetch: async (signal) => {
    const raw = await apiGet<MasonThread>('/api/verse/comms/mason-thread?since=1d', signal);
    if (raw?.schema !== 'phantom.mason.thread.v1' || !Array.isArray(raw.items)) throw new Error('Invalid Mason thread response');
    return raw;
  },
};
