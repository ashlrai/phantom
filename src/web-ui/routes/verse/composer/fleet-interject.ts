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

type FleetSendResult = { at: string; outcome: 'accepted' | 'duplicate' };

export function fleetSendStatus(result: FleetSendResult): string {
  const date = new Date(result.at);
  const time = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
    : result.at.slice(-5);
  return result.outcome === 'duplicate'
    ? `Already in the inbox (same text, sent ${time})`
    : `Sent to the leaders · ${time}`;
}

export function draftAfterSend(outcome: FleetSendResult['outcome'], draft: string, sent: string): string {
  return outcome === 'accepted' && draft === sent ? '' : draft;
}

export async function postFleetInterjection(text: string): Promise<FleetSendResult> {
  const token = getMutationToken();
  if (!token) throw mutationHoldError();
  try {
    const ack = await apiPost<{ at: string; duplicate?: unknown }>('/api/verse/fleet/runs/inbox', { text, source: 'Phantom desktop chat' }, token);
    if (!ack || typeof ack.at !== 'string') throw new Error('The message could not be confirmed. Refresh and check the inbox.');
    touchMutationHold();
    return { at: ack.at, outcome: ack.duplicate === true ? 'duplicate' : 'accepted' };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) throw new FleetInboxUnavailableError();
      if (error.status === 401 || error.status === 403) throw mutationHoldError(error.status);
    }
    throw error;
  }
}
