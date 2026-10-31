import { ApiError, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export class FleetInboxUnavailableError extends ApiError {
  constructor() {
    const reason = 'The fleet inbox is unavailable. Update the server and try again.';
    super(reason, 404, '/api/verse/fleet/runs/inbox', reason);
    this.name = 'FleetInboxUnavailableError';
  }
}

function mutationHoldError(status = 403): ApiError {
  const reason = new VerseMutationLockedError().message;
  return new ApiError(reason, status, '/api/verse/fleet/runs/inbox', reason);
}

export async function postFleetInterjection(text: string): Promise<{ at: string }> {
  const token = getMutationToken();
  if (!token) throw mutationHoldError();
  try {
    const ack = await apiPost<{ at: string }>('/api/verse/fleet/runs/inbox', { text, source: 'Phantom desktop chat' }, token);
    if (!ack || typeof ack.at !== 'string') throw new Error('The message could not be confirmed. Refresh and check the inbox.');
    touchMutationHold();
    return ack;
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) throw new FleetInboxUnavailableError();
      if (error.status === 401 || error.status === 403) throw mutationHoldError(error.status);
    }
    throw error;
  }
}
