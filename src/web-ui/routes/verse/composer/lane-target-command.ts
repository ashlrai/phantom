import { ApiError, readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { laneTargetsQuery, postLaneTarget } from '../ops/lane-targets-queries.js';

type LaneCommand = { lane: string; target: number };
export type LaneConfirmation = { lane: string; until: number };

/** A zero target requires a second submission for the same lane within five seconds. */
export function confirmNeeded(prev: LaneConfirmation | null, cmd: LaneCommand, now: number): boolean {
  return cmd.target === 0 && (!prev || prev.lane !== cmd.lane || now >= prev.until || now < prev.until - 5000);
}

export async function runLaneCommand({ lane, target }: LaneCommand): Promise<
  { ok: true; lane: string; from: number; to: number } | { ok: false; reason: string }
> {
  try {
    const current = await laneTargetsQuery.fetch();
    if (!current) return { ok: false, reason: 'Lane targets are not in this build' };
    const row = current.lanes.find(item => item.lane === lane);
    if (!row) return { ok: false, reason: `Lane ${lane} was not found.` };
    await postLaneTarget(lane, target);
    return { ok: true, lane, from: row.target, to: target };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { ok: false, reason: 'Lane targets are not in this build' };
    if (error instanceof ApiError && error.status === 409 && error.code === 'busy') {
      return { ok: false, reason: 'Another fleet control action is still running, try again in a moment' };
    }
    return { ok: false, reason: error instanceof VerseControlLockedError ? error.message : readFailureReason(error) };
  }
}
