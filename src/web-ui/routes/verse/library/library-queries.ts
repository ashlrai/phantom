/** Shared, validated desktop and phone Library reads. */
import type { MemoryEntry } from '../../../../core/cos/memory.js';
import type { LibraryPin } from '../../../../core/fleet/library-pins.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { COS_MEMORY_PATH, narrowCosMemory } from './cos-memory-model.js';
import { narrowLeaderFiles, type LeaderFilesResponse } from './library-leader-files-model.js';
import { narrowHandoffs, type HandoffsResponse } from './library-handoffs-model.js';
import { narrowMedia, type MediaList } from './library-media-model.js';

export const leaderFilesQuery: QueryDef<LeaderFilesResponse> = {
  key: 'verse-fleet-library-files',
  fetch: async (signal) => {
    const body = narrowLeaderFiles(await apiGet<unknown>('/api/verse/fleet/library-files', signal));
    if (!body) throw new Error('malformed leader files response');
    return body;
  },
};

export const handoffsQuery: QueryDef<HandoffsResponse> = {
  key: 'verse-fleet-handoffs',
  fetch: async (signal) => {
    const body = narrowHandoffs(await apiGet<unknown>('/api/verse/fleet/handoffs', signal));
    if (!body) throw new Error('malformed handoffs response');
    return body;
  },
};

export const cosMemoryQuery: QueryDef<MemoryEntry[]> = {
  key: 'verse-cos-memory',
  fetch: async (signal) => {
    const entries = narrowCosMemory(await apiGet<unknown>(COS_MEMORY_PATH, signal));
    if (!entries) throw new Error('malformed memory response');
    return entries;
  },
};

// Metadata only: screenshot bytes retain their separate mutation-token gate.
export const libraryMediaQuery: QueryDef<MediaList> = {
  key: 'verse-library-media-metadata',
  fetch: async signal => {
    const body = narrowMedia(await apiGet<unknown>('/api/verse/leader/attachment-metadata', signal));
    if (!body) throw new Error('Invalid media response');
    return body;
  },
};

export const LIBRARY_PINS_PATH = '/api/verse/library/pins';
export const LIBRARY_PINS_KEY = 'verse-library-pins';

export interface PinsResponse { v: 1; pins: LibraryPin[] }

/** A server without the route answers 404: no pins there, and no toggles either. */
export const libraryPinsQuery: QueryDef<PinsResponse | null> = {
  key: LIBRARY_PINS_KEY,
  fetch: async (signal) => {
    try { return await apiGet<PinsResponse>(LIBRARY_PINS_PATH, signal); } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
};

