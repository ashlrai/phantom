import {
  JOB_NOTES_SCHEMA, JOB_NOTE_MAX, VERSE_FLEET_RUNS_NOTES_PATH, isJobSayStatus,
  type JobNotesV1, type JobSayReceiptV1,
} from '../../../../core/fleet/job-notes-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { JOB_ID_RE } from './worker-log-model.js';

/**
 * Sending a note to one job from the job window (desktop and phone): the
 * mutation POST, shaped like job-control-action.ts, and the read that lists
 * "Notes sent". The server side is core/fleet/job-notes.ts behind
 * /api/verse/fleet/runs/notes, the same calls `phm job say|notes` make; POST
 * answers 200 with a receipt for every outcome, a finished job included.
 */
export const JOB_NOTES_PATH = VERSE_FLEET_RUNS_NOTES_PATH;
export { JOB_NOTE_MAX };

export function jobSayBody(id: string, text: string): { id: string; text: string } { return { id, text }; }

export async function postJobSay(id: string, text: string): Promise<JobSayReceiptV1> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const receipt = await apiPost<JobSayReceiptV1>(JOB_NOTES_PATH, jobSayBody(id, text), token);
    if (!receipt || !isJobSayStatus(receipt.status) || typeof receipt.job !== 'string') {
      throw new ApiError('Invalid job note response.', 502, JOB_NOTES_PATH, 'The server returned an invalid job note response.');
    }
    touchMutationHold();
    return receipt;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const message = 'This Phantom server cannot take notes for jobs yet; update the app.';
      throw new ApiError(message, 404, JOB_NOTES_PATH, message);
    }
    throw error;
  }
}

export function isJobNotes(value: unknown, job: string): value is JobNotesV1 {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<JobNotesV1>;
  return v.schema === JOB_NOTES_SCHEMA && v.job === job && typeof v.count === 'number' && Array.isArray(v.notes)
    && v.notes.every(n => typeof n?.id === 'string' && typeof n.at === 'string' && typeof n.text === 'string');
}

/** The notes sent to one job. Null where the server does not serve them (older hubs, the remote gateway). */
export function jobNotesQuery(job: string): QueryDef<JobNotesV1 | null> {
  return {
    key: `fleet-job-notes:${job}`,
    async fetch(signal) {
      if (!JOB_ID_RE.test(job)) throw new Error('Invalid job ID.');
      try {
        const value = await apiGet<unknown>(`${JOB_NOTES_PATH}?id=${encodeURIComponent(job)}`, signal);
        return isJobNotes(value, job) ? value : null;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
        throw error;
      }
    },
  };
}
