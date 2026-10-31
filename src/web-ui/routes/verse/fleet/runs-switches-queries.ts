import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

export interface RunsSwitch { id: string; on: boolean; since: string | null; effect: string }
export interface RunsSwitchesResponse {
  v: 1;
  switches: RunsSwitch[];
  sourceState: 'healthy' | 'missing' | 'degraded';
}

const PATH = '/api/verse/fleet/control/switches';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function narrow(raw: unknown): RunsSwitchesResponse {
  if (record(raw) && raw.v === 1 && ['healthy', 'missing', 'degraded'].includes(String(raw.sourceState))
    && Array.isArray(raw.switches) && raw.switches.every(row => record(row)
      && typeof row.id === 'string' && typeof row.on === 'boolean'
      && (row.since === null || typeof row.since === 'string') && typeof row.effect === 'string')) {
    return raw as unknown as RunsSwitchesResponse;
  }
  throw new ApiError('Invalid switches response.', 502, PATH, 'The server returned an invalid switches response.');
}

let missing: ApiError | null = null;
export async function getRunsSwitches(): Promise<RunsSwitchesResponse> {
  if (missing) throw missing;
  try {
    return narrow(await apiGet<unknown>(PATH));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) missing = error;
    throw error;
  }
}

export async function postRunsSwitch(id: string, on: boolean): Promise<RunsSwitchesResponse> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = narrow(await apiPost<unknown>(PATH, { id, on }, token));
  touchMutationHold();
  return result;
}
