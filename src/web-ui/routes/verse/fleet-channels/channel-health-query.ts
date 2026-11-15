import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { COMMS_STATUS_PATH } from '../fleet-inbox/comms-status-model.js';

// Same key and fetcher as the comms-status query in resources/Dot*, so the cache
// serves one request for every reader of this path.
export const channelHealthQuery: QueryDef<unknown> = {
  key: 'verse-fleet-comms-status',
  fetch: signal => apiGet<unknown>(COMMS_STATUS_PATH, signal),
};
