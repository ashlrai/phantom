import { getMutationToken } from '../../../data/auth-store.js';
import { apiPost, ApiError } from '../../../data/client.js';

export type ApplyOutcome =
  | { kind: 'updated'; toCommit: string; restart: 'sidecar' | 'manual' }
  | { kind: 'already-current' }
  | { kind: 'refused' | 'failed'; reason: string }
  | { kind: 'busy' | 'not-in-build' | 'locked' };

export async function applySelfUpdate(): Promise<ApplyOutcome> {
  const token = getMutationToken();
  if (!token) return { kind: 'locked' };
  try {
    const value = await apiPost<unknown>('/api/verse/ops/self-update', { action: 'apply' }, token);
    if (!value || typeof value !== 'object') throw new Error('Invalid update response');
    const result = value as Record<string, unknown>;
    const restart = result['restart'];
    if (!restart || typeof restart !== 'object' || Array.isArray(restart)) throw new Error('Invalid update response');
    switch (result['outcome']) {
      case 'updated': {
        const mode = (restart as Record<string, unknown>)['mode'];
        if (typeof result['toCommit'] !== 'string' || !/^[a-f0-9]{7,64}$/i.test(result['toCommit'])
          || (mode !== 'sidecar-supervised' && mode !== 'manual')) throw new Error('Invalid update response');
        return { kind: 'updated', toCommit: result['toCommit'], restart: mode === 'sidecar-supervised' ? 'sidecar' : 'manual' };
      }
      case 'already-current': return { kind: 'already-current' };
      case 'refused':
      case 'failed':
        return { kind: result['outcome'], reason: typeof result['reason'] === 'string' ? result['reason'] : 'No reason was provided.' };
      default: throw new Error('Invalid update response');
    }
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 409) return { kind: 'busy' };
      if (error.status === 404 || (error.status === 400 && /fetch/i.test(error.message))) return { kind: 'not-in-build' };
    }
    // Do not echo transport exceptions, which may contain request details.
    return { kind: 'failed', reason: 'The update could not be confirmed. Check the status before trying again.' };
  }
}
