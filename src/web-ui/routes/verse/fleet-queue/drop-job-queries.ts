import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import type { DropJobDraft, DropJobItem } from './drop-job-model.js';
const path = '/api/verse/fleet/live/drop-jobs';
function isItem(item: unknown): item is DropJobItem {
  if (!item || typeof item !== 'object') return false;
  const row = item as Record<string, unknown>;
  return ['id', 'lane', 'tier', 'title'].every(key => typeof row[key] === 'string')
    && ['bytes', 'ageSeconds'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key]) && (row[key] as number) >= 0);
}
export const dropJobsQuery: QueryDef<{ v: 1; items: DropJobItem[] } | null> = {
  key: 'verse-fleet-drop-jobs',
  async fetch(signal) {
    try {
      const raw = await apiGet<unknown>(path, signal);
      if (!raw || typeof raw !== 'object' || !('v' in raw) || raw.v !== 1 || !('items' in raw) || !Array.isArray(raw.items) || !raw.items.every(isItem)) throw new Error('Invalid drop jobs response.');
      return { v: 1, items: raw.items };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
export async function postDropJob(draft: DropJobDraft): Promise<{ status: number; payload: unknown }> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const payload = await apiPost<unknown>(path, draft, token);
    touchMutationHold();
    return { status: 201, payload };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, payload: { reasons: [error.detail ?? 'The server rejected the draft.'] } };
  }
}
