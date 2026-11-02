import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { palettePhone, type PalettePhone } from './palette-phone.js';

export const palettePhoneQuery: QueryDef<PalettePhone | { kind: 'notInBuild' }> = {
  key: 'verse-remote-phone-palette',
  async fetch(signal) {
    try {
      const phone = palettePhone(await apiGet<unknown>('/api/verse/fleet/control/remote-phone', signal));
      if (!phone) throw new Error('Invalid remote phone response');
      return phone;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: 'notInBuild' };
      throw error;
    }
  },
};
