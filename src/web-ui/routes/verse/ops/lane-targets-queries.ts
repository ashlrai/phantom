import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { isLaneTargets, type LaneTargetsV1 } from './lane-targets-model.js';

const PATH = '/api/verse/fleet/control/lanes';

function narrow(value: unknown): LaneTargetsV1 {
  if (!isLaneTargets(value)) throw new ApiError('Invalid lane targets response.', 502, PATH, 'The server returned an invalid lane targets response.');
  return value;
}

export const laneTargetsQuery: QueryDef<LaneTargetsV1 | null> = {
  key: 'verse-fleet-lane-targets',
  async fetch(signal) {
    try { return narrow(await apiGet<unknown>(PATH, signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

export async function postLaneTarget(lane: string, target: number): Promise<LaneTargetsV1> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = narrow(await apiPost<unknown>(PATH, { lane, target }, token));
  touchMutationHold();
  return result;
}
