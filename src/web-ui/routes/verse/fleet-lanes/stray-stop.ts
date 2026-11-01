import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

export const STRAY_STOP_PATH = '/api/verse/fleet/control/stray-slots';

export async function postStrayStop(lane: string, job: string, pid: number): Promise<unknown> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const result = await apiPost<unknown>(STRAY_STOP_PATH, { action: 'stop', lane, job, pid }, token);
    touchMutationHold();
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const message = 'This Phantom server cannot stop strays yet; update the app.';
      throw new ApiError(message, 404, STRAY_STOP_PATH, message);
    }
    throw error;
  }
}
