import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowRuntimeIdentity, type RuntimeIdentityView } from './runtime-identity-model.js';

export const runtimeIdentityQuery: QueryDef<RuntimeIdentityView | null> = {
  key: 'verse-fleet-runtime-identity',
  async fetch(signal) {
    try { return narrowRuntimeIdentity(await apiGet<unknown>('/api/verse/fleet/runtime-identity', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
