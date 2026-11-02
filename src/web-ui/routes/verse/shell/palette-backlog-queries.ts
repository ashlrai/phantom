import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { paletteBacklog, type PaletteBacklogItem } from './palette-backlog.js';

export const paletteBacklogQuery: QueryDef<PaletteBacklogItem[]> = {
  key: 'verse-palette-phantom-backlog',
  async fetch(signal) {
    try {
      return paletteBacklog(await apiGet<unknown>('/api/verse/github/fleet-backlog?repo=ashlrai%2Fphantom', signal));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return [];
      throw error;
    }
  },
};
