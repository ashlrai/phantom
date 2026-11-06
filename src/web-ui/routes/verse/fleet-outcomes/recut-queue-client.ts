import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost, ApiError, DispatchDisabledError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { recutJob } from './recut-job-body.js';

const PATH = '/api/verse/fleet/live/drop-jobs';
export const recutDropJobsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-drop-jobs',
  fetch: signal => apiGet<unknown>(PATH, signal),
};

export async function queueRecut(job: NonNullable<ReturnType<typeof recutJob>>): Promise<'queued' | 'already queued' | 'unavailable'> {
  const token = getMutationToken();
  if (!token) throw new Error('Hold a mutation token to queue a recut.');
  try {
    await apiPost<unknown>(PATH, job, token);
    return 'queued';
  } catch (error) {
    if (error instanceof DispatchDisabledError || (error instanceof ApiError && error.status === 404)) return 'unavailable';
    if (error instanceof ApiError && error.status === 409) return 'already queued';
    throw error;
  } finally {
    touchMutationHold();
  }
}
