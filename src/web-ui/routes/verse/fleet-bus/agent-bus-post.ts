import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost } from '../../../data/client.js';
import type { buildMasonEnvelope, PostOutcome } from './bus-post-model.js';

export async function postBusEnvelope(envelope: ReturnType<typeof buildMasonEnvelope>): Promise<PostOutcome> {
  const token = getMutationToken();
  if (!token) return { status: 'locked' };
  try {
    const result = await apiPost<{ status?: unknown; cursor?: unknown }>('/api/verse/agent-bus', envelope, token);
    if ((result?.status !== 'posted' && result?.status !== 'duplicate') || !Number.isSafeInteger(result.cursor) || (result.cursor as number) < 1) {
      return { status: 'unavailable' };
    }
    touchMutationHold();
    return { status: result.status, cursor: result.cursor as number };
  } catch (error) {
    if (error instanceof ApiError) {
      switch (error.status) {
        case 400: return { status: 'invalid' };
        case 401: case 403: return { status: 'locked' };
        case 404: return { status: 'dispatch-disabled' };
        case 409: return { status: 'conflict' };
        case 507: return { status: 'full' };
      }
    }
    return { status: 'unavailable' };
  }
}
