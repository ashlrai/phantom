import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { readRunsNow, type RunsNow } from './runs-now-model.js';

export async function fetchRunsNow(signal: AbortSignal): Promise<RunsNow | null> {
  return readRunsNow(await apiGet<unknown>('/api/verse/fleet/runs', signal));
}

/** Shared with the shell warm-up so the first Command visit can reuse its read. */
export const runsNowQuery: QueryDef<RunsNow | null> = {
  key: 'command-runs-now',
  fetch: (signal) => fetchRunsNow(signal ?? new AbortController().signal),
};
