import { apiGet } from '../../../data/client.js';
import { readRunsNow, type RunsNow } from './runs-now-model.js';

export async function fetchRunsNow(signal: AbortSignal): Promise<RunsNow | null> {
  return readRunsNow(await apiGet<unknown>('/api/verse/fleet/runs', signal));
}
