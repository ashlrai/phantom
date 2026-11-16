import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost, DispatchDisabledError } from '../../../data/client.js';

const BIND_PATH = '/api/verse/fleet/coordination-claims/bind';
/** Same two grammars as the host's validateClaimThreadKey; the host stays authoritative. */
const TEAM = '[TE][A-Z0-9]{2,32}';
const CHANNEL = '[CDG][A-Z0-9]{2,32}';
const TS = '\\d{1,20}\\.\\d{1,10}';
const SLASH = new RegExp(`^${TEAM}/${CHANNEL}/${TS}$`);
const COLON = new RegExp(`^slack:${TEAM}:${CHANNEL}:${TS}$`);

export const NEEDS_NEWER_HOST = 'Binding from the console needs a newer host; use the CLI hint.';

export function isThreadKey(value: string): boolean {
  return SLASH.test(value) || COLON.test(value);
}

export type BindOutcome =
  | { kind: 'bound' | 'unchanged' | 'rebound' }
  | { kind: 'failed'; outcome: string }
  | { kind: 'no-route' };

/** Bind one live claim to its Slack thread; never reports success it did not get. */
export async function bindClaimThread(claimId: string, repo: string, thread: string): Promise<BindOutcome> {
  const token = getMutationToken();
  if (!token) return { kind: 'failed', outcome: 'locked' };
  try {
    const value = await apiPost<unknown>(BIND_PATH, { claimId, repo, thread: thread.trim() }, token);
    touchMutationHold();
    const outcome = (value as { outcome?: unknown } | null)?.outcome;
    if (outcome === 'bound' || outcome === 'rebound' || outcome === 'unchanged') return { kind: outcome };
    return { kind: 'failed', outcome: 'unavailable' };
  } catch (error) {
    // A codeless 404 is a host without this route (or dispatch off); the
    // route's own not-found answers with a body, so it stays an ApiError.
    if (error instanceof DispatchDisabledError) return { kind: 'no-route' };
    const outcome = error instanceof ApiError ? (error.body as { outcome?: unknown } | null)?.outcome : undefined;
    return { kind: 'failed', outcome: typeof outcome === 'string' && /^[a-z-]{1,24}$/.test(outcome) ? outcome : 'unavailable' };
  }
}
