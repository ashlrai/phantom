/**
 * GET /api/verse/world — the cached ashlr.world-model/v1 snapshot.
 * The resource bar polls this existing route. There is no world SSE event.
 */
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const worldModelQuery: QueryDef<unknown> = {
  key: 'verse-world',
  fetch: (signal) => apiGet<unknown>('/api/verse/world', signal),
};
