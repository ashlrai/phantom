import { ApiError, apiGet } from '../../../data/client.js';
import { readCodexPersonal, type PersonalReading } from './codex-burn-model.js';

/** A missing route is remembered for one visit to the section. */
export function personalReader() {
  let missing = false;
  return async (signal: AbortSignal): Promise<{ missing: boolean; reading: PersonalReading | null; sourceState: string | null }> => {
    if (missing) return { missing, reading: null, sourceState: null };
    try {
      const raw = await apiGet<unknown>('/api/verse/fleet/runs', signal);
      const sources = typeof raw === 'object' && raw !== null && 'sources' in raw ? raw.sources : null;
      const state = typeof sources === 'object' && sources !== null && 'codex' in sources ? sources.codex : null;
      const sourceState = typeof state === 'string' && ['healthy', 'degraded', 'missing', 'not-landed'].includes(state) ? state : null;
      return { missing: false, reading: readCodexPersonal(raw), sourceState };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        missing = true;
        return { missing, reading: null, sourceState: null };
      }
      throw error;
    }
  };
}
