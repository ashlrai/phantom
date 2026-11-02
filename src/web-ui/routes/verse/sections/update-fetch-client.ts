import { getMutationToken } from '../../../data/auth-store.js';
import { apiPost, ApiError } from '../../../data/client.js';

export type FetchOutcome =
  | { kind: 'fetched'; at: string }
  | { kind: 'locked' | 'not-in-build' }
  | { kind: 'failed'; reason: string };

export async function fetchOriginNow(): Promise<FetchOutcome> {
  const token = getMutationToken();
  if (!token) return { kind: 'locked' };
  try {
    const value = await apiPost<unknown>('/api/verse/ops/self-update', { action: 'fetch' }, token);
    if (value && typeof value === 'object' && 'ok' in value && value.ok === true
      && 'action' in value && value.action === 'fetch' && 'fetchedAt' in value && typeof value.fetchedAt === 'string' && value.fetchedAt) {
      return { kind: 'fetched', at: value.fetchedAt };
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'not-in-build' };
  }
  return { kind: 'failed', reason: 'Could not fetch origin. Try again.' };
}
