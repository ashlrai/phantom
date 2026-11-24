/**
 * The one live lane reading the self-tick (autofill and gap hook) and `phm jobs gaps` share.
 * Same facts `phm pools` shows, with the local lane clamped to free memory.
 */
import type { LaneFacts } from './autofill-lanes.js';

export async function readLiveLaneFacts(runsDir: string): Promise<{ lanes: LaneFacts[] }> {
  const { getFleetLaneSnapshot } = await import('./lane-console.js');
  const snapshot = await getFleetLaneSnapshot();
  // Clamp only the local lane to available memory, retaining the shared lane eligibility facts.
  const { readLocalCapacity, clampLocalTarget, LOCAL_LANE } = await import('./local-capacity.js');
  const room = await readLocalCapacity({ runsDir });
  return {
    lanes: snapshot.lanes.map(view => ({
      lane: view.lane, running: view.liveJobs ?? null,
      target: (view.lane === LOCAL_LANE ? clampLocalTarget(view.slotTarget ?? null, room) : view.slotTarget) ?? null,
      queued: view.queueDepth ?? null,
      held: view.hold?.held === true, remainingPct: view.credit.remainingPct, resetAt: view.credit.resetAt,
    })),
  };
}
