import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { DropJobFatesV1 } from '../../../../core/fleet/drop-job-fate.js';

import { narrowDropFates } from './drop-fate-model.js';

export const dropFateQuery: QueryDef<DropJobFatesV1 | null> = {
  key: 'verse-fleet-drop-fates',
  async fetch(signal) {
    try { return narrowDropFates(await apiGet<unknown>('/api/verse/fleet/control/drop-fates', signal)); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  },
};
