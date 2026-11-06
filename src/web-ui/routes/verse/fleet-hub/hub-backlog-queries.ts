import { getReadClientProof, reportSessionExpired } from '../../../data/auth-store.js';
import { ApiError, apiGet, METADATA_JSON_READ_TIMEOUT_MS, MetadataReadTimeoutError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';

const path = '/api/verse/github/fleet-backlog?repo=ashlrai%2Fphantom';

export const hubBacklogQuery: QueryDef<unknown | null> = {
  key: 'verse-hub-phantom-merge-backlog',
  async fetch(signal) {
    try {
      // The shared client rejects 503 bodies, but this route uses 503 for its
      // structured gh-failed snapshot. Preserve that body on the desktop.
      if (isRemoteMobileMode()) return await apiGet<unknown>(path, signal);
      const controller = new AbortController();
      const cancel = () => controller.abort(signal?.reason);
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(new MetadataReadTimeoutError()), METADATA_JSON_READ_TIMEOUT_MS);
      try {
        const response = await fetch(path, { method: 'GET', credentials: 'same-origin',
          headers: { 'x-ashlr-read-client': getReadClientProof() }, signal: controller.signal });
        if (response.status === 401) reportSessionExpired();
        if (response.status === 404) return null;
        if (!response.ok && response.status !== 503) throw new ApiError('Backlog read failed.', response.status, path);
        return await response.json() as unknown;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
