import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

export const LANE_HOLDS_PATH = '/api/verse/fleet/control/holds';

export function holdKind(reason: string | null): 'autobackoff' | 'manual' | null {
  if (!reason) return null;
  return reason.startsWith('autobackoff') ? 'autobackoff' : 'manual';
}

export function releaseLabel(kind: 'autobackoff' | 'manual', heldUntil: string | null, nowMs: number): string {
  if (kind === 'manual') return 'Held by hand';
  const expiry = heldUntil ? new Date(heldUntil) : null;
  if (!expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= nowMs) return 'Release hold';
  const hours = String(expiry.getHours()).padStart(2, '0');
  const minutes = String(expiry.getMinutes()).padStart(2, '0');
  return `Release hold (expires ${hours}:${minutes})`;
}

export async function postReleaseHold(lane: string, reason: string): Promise<unknown> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const result = await apiPost<unknown>(LANE_HOLDS_PATH, { lane, action: 'release', reason }, token);
    touchMutationHold();
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const message = 'This Phantom server cannot release holds yet; update the app.';
      throw new ApiError(message, 404, LANE_HOLDS_PATH, message);
    }
    throw error;
  }
}
