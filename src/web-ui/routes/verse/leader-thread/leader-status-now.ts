import { ApiError, apiGet } from '../../../data/client.js';

/** Read only; absent or unavailable status is represented as null. */
export async function fetchLeaderStatusNow(signal?: AbortSignal): Promise<string | null> {
  try {
    const value = await apiGet<unknown>('/api/verse/comms/owner-thread/status', signal);
    if (typeof value !== 'object' || value === null) return null;
    const result = value as Record<string, unknown>;
    return result.schema === 'comms.owner-status.v1' && typeof result.text === 'string' && result.unavailable !== true ? result.text : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
