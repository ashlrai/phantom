import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { readPhoneAccess, type PhoneAccess } from './phone-access-model.js';

export const phoneAccessQuery: QueryDef<PhoneAccess | { kind: 'notInBuild' }> = {
  key: 'verse-remote-phone',
  async fetch(signal) {
    try {
      const data = readPhoneAccess(await apiGet<unknown>('/api/verse/fleet/control/remote-phone', signal));
      if (!data) throw new Error('Invalid phone access response');
      return data;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: 'notInBuild' };
      throw error;
    }
  },
};
