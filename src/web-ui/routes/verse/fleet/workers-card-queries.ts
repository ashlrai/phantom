import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowWorkers, narrowJob, validJob } from './workers-card-model.js';

const missing = new Map<string, ApiError>();
export const notInBuild = (error: unknown): boolean => error instanceof ApiError && (error.status === 404 || error.status === 503);
function query<T>(key: string, path: string, narrow: (value: unknown) => T | null): QueryDef<T> {
  return { key, async fetch(signal) {
    if (missing.has(path)) throw missing.get(path);
    try {
      const value = narrow(await apiGet<unknown>(path, signal));
      if (value === null) throw new Error('Invalid worker response');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing.set(path, error);
      throw error;
    }
  } };
}
export const workersQuery = query('verse-fleet-workers', '/api/verse/fleet/runs', narrowWorkers);
export function jobDetailQuery(job: string) {
  if (!validJob(job)) throw new Error('Invalid job id');
  return query(`verse-fleet-job:${job}`, `/api/fleet/job?id=${encodeURIComponent(job)}`, value => {
    const detail = narrowJob(value);
    return detail?.job === job ? detail : null;
  });
}
