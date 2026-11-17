import {
  JOB_CONTROL_STATUSES, VERSE_FLEET_RUNS_CONTROL_PATH, isJobControlAction,
  type JobControlAction, type JobControlReceiptV1,
} from '../../../../core/fleet/job-control-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

/**
 * Steering one job from the job detail: pause, resume, stop, move. The
 * request shape plus the mutation POST, shaped like job-stop-action.ts (whose
 * eligibility rule and failure text JobControls reuses): the held control
 * token and a touch on success. The server side is core/fleet/job-control.ts
 * behind POST /api/verse/fleet/runs/control, the same call `phm job <action>`
 * makes; it answers 200 with a receipt for every outcome, refusals included.
 */
export const JOB_CONTROL_PATH = VERSE_FLEET_RUNS_CONTROL_PATH;

export function jobControlBody(id: string, action: JobControlAction, lane?: string): { id: string; action: JobControlAction; lane?: string } {
  return lane === undefined ? { id, action } : { id, action, lane };
}

export async function postJobControl(id: string, action: JobControlAction, lane?: string): Promise<JobControlReceiptV1> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const receipt = await apiPost<JobControlReceiptV1>(JOB_CONTROL_PATH, jobControlBody(id, action, lane), token);
    if (!receipt || !JOB_CONTROL_STATUSES.includes(receipt.status) || !isJobControlAction(receipt.action) || typeof receipt.job !== 'string') {
      throw new ApiError('Invalid job control response.', 502, JOB_CONTROL_PATH, 'The server returned an invalid job control response.');
    }
    touchMutationHold();
    return receipt;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const message = 'This Phantom server cannot steer jobs yet; update the app.';
      throw new ApiError(message, 404, JOB_CONTROL_PATH, message);
    }
    throw error;
  }
}
