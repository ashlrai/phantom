import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost, readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { parsePlanCommand } from './composer-text.js';

interface PassResult { v: number; provider: string | null; outcome: string; exitCode: number | null }

export async function runPlanCommand(draft: string): Promise<{ ok: boolean; text: string }> {
  const command = parsePlanCommand(draft);
  if (!command) return { ok: false, text: 'Use /plan [reason] to run a planner pass.' };
  try {
    const token = getMutationToken();
    if (!token) throw new VerseControlLockedError();
    const result = await apiPost<PassResult>('/api/verse/leader/planner/run', command, token);
    touchMutationHold();
    if (result.v !== 1 || typeof result.outcome !== 'string') return { ok: false, text: 'The server returned an invalid planner response.' };
    return { ok: result.outcome === 'ran' && result.exitCode === 0,
      text: `Planner pass ran on ${result.provider ?? 'no provider'}: ${result.outcome} (exit ${result.exitCode ?? 'none'})` };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      if (error.detail === 'no-slate') return { ok: false, text: 'No planner slate declared' };
      if (error.detail === 'no-prompt-declared') return { ok: false, text: 'No prompt declared in the slate' };
      if (error.detail === 'pass-in-flight') return { ok: false, text: 'A planner pass is already running' };
    }
    return { ok: false, text: error instanceof VerseControlLockedError ? error.message : readFailureReason(error) };
  }
}
