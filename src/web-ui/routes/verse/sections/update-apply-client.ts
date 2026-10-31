import { getMutationToken } from '../../../data/auth-store.js';
import { apiPost, ApiError } from '../../../data/client.js';

export type ApplyStep = { name: string; ok: boolean; ms: number; note: string | null };

export type ApplyOutcome =
  | { kind: 'updated'; toCommit: string; restart: 'sidecar' | 'manual'; steps?: ApplyStep[] }
  | { kind: 'already-current'; steps?: ApplyStep[] }
  | { kind: 'refused' | 'failed'; reason: string; steps?: ApplyStep[] }
  | { kind: 'busy' | 'not-in-build' | 'locked' };

function parseSteps(value: unknown): ApplyStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const { name, ok, ms, note } = row as Record<string, unknown>;
    return typeof name === 'string' && /^[a-z-]{1,20}$/.test(name) && typeof ok === 'boolean'
      && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
      && (note === null || (typeof note === 'string' && note.length <= 400)) ? [{ name, ok, ms, note }] : [];
  });
}

export async function applySelfUpdate(): Promise<ApplyOutcome> {
  const token = getMutationToken();
  if (!token) return { kind: 'locked' };
  try {
    const value = await apiPost<unknown>('/api/verse/ops/self-update', { action: 'apply' }, token);
    if (!value || typeof value !== 'object') throw new Error('Invalid update response');
    const result = value as Record<string, unknown>;
    const steps = parseSteps(result['steps']);
    const stepData = steps === undefined ? {} : { steps };
    const restart = result['restart'];
    if (!restart || typeof restart !== 'object' || Array.isArray(restart)) throw new Error('Invalid update response');
    switch (result['outcome']) {
      case 'updated': {
        const mode = (restart as Record<string, unknown>)['mode'];
        if (typeof result['toCommit'] !== 'string' || !/^[a-f0-9]{7,64}$/i.test(result['toCommit'])
          || (mode !== 'sidecar-supervised' && mode !== 'manual')) throw new Error('Invalid update response');
        return { kind: 'updated', toCommit: result['toCommit'], restart: mode === 'sidecar-supervised' ? 'sidecar' : 'manual', ...stepData };
      }
      case 'already-current': return { kind: 'already-current', ...stepData };
      case 'refused':
      case 'failed':
        return { kind: result['outcome'], reason: typeof result['reason'] === 'string' ? result['reason'] : 'No reason was provided.', ...stepData };
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
