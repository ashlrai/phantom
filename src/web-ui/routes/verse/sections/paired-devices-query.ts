import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PairedDevicesSnapshot } from './paired-devices-model.js';

export const pairedDevicesQuery: QueryDef<PairedDevicesSnapshot | { kind: 'notInBuild' }> = {
  key: 'verse-remote-devices',
  async fetch(signal) {
    try {
      const data = await apiGet<PairedDevicesSnapshot>('/api/verse/fleet/control/remote-devices', signal);
      if (data?.v !== 1 || !Array.isArray(data.devices)) throw new Error('Invalid paired devices response');
      return data;
    }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: 'notInBuild' };
      throw error;
    }
  },
};
