import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

export const QUEUE_MOVE_PATH = '/api/verse/fleet/runs/reassign';
export interface QueueMoveReport {
  v: 1; applied: boolean; lane: string;
  moved: { id: string; fromLane: string; toLane: string; fromTier: string; toTier: string }[];
  skipped: { id: string; reason: string }[];
  verified: boolean | null;
}
export function queueMoveBody(fromLane: string, lane: string, tier?: string) {
  return { fromLane, lane, ...(tier ? { tier } : {}) };
}
const refusals = {
  'job-not-found': 'Job was not found.', 'job-launched': 'Job has already launched.',
  'job-parked': 'Job is parked.', 'lane-unknown': 'Target lane is unknown.',
  'lane-same': 'Choose a different lane.', 'lane-down': 'Target lane is down.',
  'lane-held': 'Target lane is held.', 'tier-unknown': 'Tier is unknown.',
  'queue-missing': 'Queue is unavailable.',
};
export function moveRefusalText(reason: string): string {
  return refusals[reason as keyof typeof refusals] ?? 'The move was refused.';
}
export function moveOutcomeText(report: QueueMoveReport): string {
  const count = report.moved.length;
  return `moved ${count} ${count === 1 ? 'job' : 'jobs'}${count ? ` to ${report.lane}` : ''}${report.skipped.length ? ` (${report.skipped.length} skipped)` : ''}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function parseQueueMoveReport(value: unknown): QueueMoveReport {
  if (!record(value) || value.v !== 1 || typeof value.applied !== 'boolean' || typeof value.lane !== 'string'
    || !(value.verified === null || typeof value.verified === 'boolean')
    || !Array.isArray(value.moved) || !value.moved.every(row => record(row) && ['id', 'fromLane', 'toLane', 'fromTier', 'toTier'].every(key => typeof row[key] === 'string'))
    || !Array.isArray(value.skipped) || !value.skipped.every(row => record(row) && typeof row.id === 'string' && typeof row.reason === 'string')) {
    throw new ApiError('Invalid move response.', 502, QUEUE_MOVE_PATH, 'The server returned an invalid move response.');
  }
  return value as unknown as QueueMoveReport;
}
export async function postQueueMove(fromLane: string, lane: string, tier?: string): Promise<QueueMoveReport> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  try {
    const result = parseQueueMoveReport(await apiPost<unknown>(QUEUE_MOVE_PATH, queueMoveBody(fromLane, lane, tier), token));
    touchMutationHold();
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !error.code) {
      const message = 'This Phantom server cannot move jobs yet; update the app.';
      throw new ApiError(message, 404, QUEUE_MOVE_PATH, message);
    }
    if (error instanceof ApiError && error.code === 'REASSIGN_REFUSED') {
      const message = moveRefusalText(error.detail ?? '');
      throw new ApiError(message, error.status, QUEUE_MOVE_PATH, message, error.code);
    }
    throw error;
  }
}
