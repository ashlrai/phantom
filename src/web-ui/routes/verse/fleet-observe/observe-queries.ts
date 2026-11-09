import type { ObserveSnapshot, SessionDetail } from '../../../../core/observe/types.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const observeQuery: QueryDef<ObserveSnapshot> = {
  key: 'verse-observe',
  fetch: (signal) => apiGet<ObserveSnapshot>('/api/verse/observe', signal),
};

export function observeSessionQuery(id: string): QueryDef<SessionDetail> {
  return {
    key: `verse-observe-session:${id}`,
    fetch: (signal) => apiGet<SessionDetail>(`/api/verse/observe/session?id=${encodeURIComponent(id)}`, signal),
  };
}
