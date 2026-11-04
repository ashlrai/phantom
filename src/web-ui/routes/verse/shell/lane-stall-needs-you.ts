/**
 * routes/verse/shell/lane-stall-needs-you.ts — the Needs-you row for a lane
 * that has work and capacity but is not launching: queued > 0, running <
 * target, not held, and no launch for LANE_STALL_MINUTES. Read-only: it
 * reports from the same GET /api/verse/fleet/runs lane rows the cards use and
 * never launches, unholds or restarts anything.
 *
 * Last launch is the newest of a lane's claimed job and its youngest running
 * worker. The wire has no explicit launch stamp, so a lane with neither is
 * "unknown": the row still shows, without the minute count.
 */
import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

export const LANE_STALL_MINUTES = 15;
export const LANE_STALL_MS = LANE_STALL_MINUTES * 60_000;
/** A held_reason like "usage_limit" is the usage-reset rows' business, not a stall. */
const USAGE_LIMIT_REASON = /usage[_\s-]?limit/i;

export const laneStallId = (lane: string): string => `lane-stall:${lane}`;

function lastLaunchMs(runs: FleetRuns, lane: string): number | null {
  const times: number[] = [];
  for (const job of runs.claimed ?? []) {
    const at = Date.parse(job.at);
    if (job.lane === lane && Number.isFinite(at)) times.push(at);
  }
  const generatedAt = Date.parse(runs.generatedAt);
  for (const worker of runs.workers) {
    if (worker.lane === lane && worker.ageSeconds !== null && Number.isFinite(generatedAt)) {
      times.push(generatedAt - worker.ageSeconds * 1_000);
    }
  }
  return times.length ? Math.max(...times) : null;
}

export function deriveLaneStallNeedsYou(runs: FleetRuns | null | undefined, nowMs: number = Date.now()): FleetNeedsYouItem[] {
  if (!runs) return [];
  const items: FleetNeedsYouItem[] = [];
  for (const l of runs.lanes) {
    if (l.held || l.target <= 0 || l.running >= l.target || l.queued <= 0) continue;
    if (l.heldReason && USAGE_LIMIT_REASON.test(l.heldReason)) continue;
    const launchedAt = lastLaunchMs(runs, l.lane);
    const minutes = launchedAt === null ? null : Math.floor(Math.max(0, nowMs - launchedAt) / 60_000);
    if (minutes !== null && minutes < LANE_STALL_MINUTES) continue;
    items.push({
      id: laneStallId(l.lane),
      open: { kind: 'pane', paneId: 'fleet-lanes', lane: l.lane },
      severity: 'urgent',
      title: `${l.lane} stalled: ${l.queued} queued, ${l.running} of ${l.target} running, not held, ${minutes === null ? 'no launch observed' : `no launch for ${minutes} min`}`,
      detail: 'The lane has work and free slots and is not held, yet nothing is launching.',
      nextStep: `Open ${l.lane} in Lanes and check the dispatcher`,
      target: 'fleet',
    });
  }
  return items;
}
