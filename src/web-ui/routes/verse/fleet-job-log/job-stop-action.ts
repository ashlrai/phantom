import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost, readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import type { FleetJobDetailV1 } from './worker-log-model.js';

/**
 * One-job stop for the Worker log pane — the pure parts (request shape, the
 * two-click confirm window, outcome text) plus the mutation POST, shaped
 * like the lane-release client: the held control token, a touch on success,
 * and the control-token sentences the client already produces. The server
 * side is core/fleet/job-stop.ts behind POST /api/verse/fleet/runs/stop:
 * 202 with the result, 409 when nothing was running, 400 for an invalid id.
 */
export const JOB_STOP_PATH = '/api/verse/fleet/runs/stop';
/** First click arms the button for this window; the second click posts. */
export const STOP_CONFIRM_MS = 5_000;

export type JobStopOutcome = 'stopped' | 'not-running' | 'refused';
export interface JobStopResult { id: string; pids: number[]; outcome: JobStopOutcome; at: string }

export function jobStopBody(id: string): { id: string } { return { id }; }

/** The pane shows Stop while the selected job is not finished (the liveness
 * model's finished is published|archived; 'unknown' can still be live). */
export function jobStopEligible(state: FleetJobDetailV1['state'] | null | undefined): boolean {
  return state === 'running' || state === 'unknown';
}

export function stopConfirmLabel(id: string, armed: boolean): string {
  return armed ? `Stop ${id}? click again` : 'Stop';
}

export function stopOutcomeText(result: JobStopResult): string {
  if (result.outcome === 'stopped') {
    return `stopped ${result.pids.length} ${result.pids.length === 1 ? 'process' : 'processes'}`;
  }
  return result.outcome === 'not-running' ? 'not running' : 'refused';
}

const OUTCOMES: readonly JobStopOutcome[] = ['stopped', 'not-running', 'refused'];

/** The inline sentence for a stop failure: the locked-token text, then the
 * client's own sentence on a 401, then the route's refusal like the panes. */
export function stopFailureText(error: unknown): string {
  if (error instanceof VerseControlLockedError) return error.message;
  if (error instanceof ApiError && error.status === 401) return error.message;
  if (error instanceof ApiError) return readFailureReason(error);
  if (error instanceof Error) return error.message;
  return 'The request failed.';
}

export async function postJobStop(id: string): Promise<JobStopResult> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const result = await apiPost<JobStopResult>(JOB_STOP_PATH, jobStopBody(id), token);
    if (!result || !OUTCOMES.includes(result.outcome) || !Array.isArray(result.pids)) {
      throw new ApiError('Invalid stop response.', 502, JOB_STOP_PATH, 'The server returned an invalid stop response.');
    }
    touchMutationHold();
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const message = 'This Phantom server cannot stop jobs yet; update the app.';
      throw new ApiError(message, 404, JOB_STOP_PATH, message);
    }
    // The route's 409 means the stop found no live process; surface it as an
    // outcome, not a failure.
    if (error instanceof ApiError && error.status === 409) {
      return { id, pids: [], outcome: 'not-running', at: new Date().toISOString() };
    }
    throw error;
  }
}
