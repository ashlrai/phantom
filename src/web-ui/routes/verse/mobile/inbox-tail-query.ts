import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';

export interface InboxEntry { at: string; source: string; text: string }

export function narrowInboxTail(value: unknown): InboxEntry[] {
  if (typeof value !== 'object' || value === null || !('inbox' in value) || !Array.isArray(value.inbox)
    || !value.inbox.every((entry: unknown) => typeof entry === 'object' && entry !== null
      && 'at' in entry && typeof entry.at === 'string'
      && 'source' in entry && typeof entry.source === 'string'
      && 'text' in entry && typeof entry.text === 'string')) {
    throw new Error('The fleet inbox response was malformed.');
  }
  return value.inbox.map(({ at, source, text }: InboxEntry) => ({ at, source, text }));
}

let missing: ApiError | null = null;
export const inboxTailQuery: QueryDef<{ inbox: InboxEntry[]; snapshot: FleetRunsV1 | undefined }> = {
  key: 'verse-mobile-inbox-tail',
  async fetch(signal) {
    if (missing) throw missing;
    try {
      const value = await apiGet<unknown>('/api/verse/fleet/runs', signal);
      const inbox = narrowInboxTail(value);
      const snapshot = isFleetRuns(value) && value.host !== undefined ? { ...value, host: value.host } : undefined;
      return { inbox, snapshot };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};
