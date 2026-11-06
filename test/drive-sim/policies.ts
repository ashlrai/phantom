/**
 * drive-sim reference policies: three points in the policy space, built only
 * on the stubbed snapshot so the seam stays honest.
 *
 *   fifo-pool   The naive baseline. Strict FIFO over the queue, dispatch only
 *               to the job's assigned pool, never spill. Head-of-line jobs on
 *               a paused or saturated lane simply wait; nothing is reordered.
 *
 *   balanced    FIFO jobs onto the least-loaded allowed lane. Spills freely;
 *               ignores floors and pace entirely.
 *
 *   pace-floor  The "what the driver should probably do" candidate. P0 jobs
 *               jump the queue; each job picks the best allowed lane by
 *               (below floor first, behind pace next, own pool next, least
 *               busy last). A lane running well ahead of its pace target is
 *               held to it: it only takes more work when every allowed lane
 *               is also ahead, so an idle lane never burns its day early while
 *               a sibling starves.
 */
import type { LaneId } from './model.js';
import type { DriveDecision, DrivePolicy, LaneView, QueuedJobView, SimSnapshot } from './policy.js';

const PRIORITY_RANK: Readonly<Record<QueuedJobView['priority'], number>> = { P0: 0, P1: 1, P2: 2 };

/** Free slots left after accounting for dispatches already chosen this tick. */
function spendable(lanes: LaneView[], planned: Map<LaneId, number>): Map<LaneId, number> {
  const left = new Map<LaneId, number>();
  for (const l of lanes) left.set(l.id, Math.max(0, l.freeSlots) - (planned.get(l.id) ?? 0));
  return left;
}

function candidates(job: QueuedJobView, lanes: LaneView[], left: Map<LaneId, number>): LaneView[] {
  const byId = new Map(lanes.map((l) => [l.id, l]));
  const out: LaneView[] = [];
  for (const id of job.allowed) {
    const l = byId.get(id);
    if (l && !l.paused && (left.get(id) ?? 0) > 0) out.push(l);
  }
  return out;
}

export function fifoPoolPolicy(): DrivePolicy {
  return {
    name: 'fifo-pool',
    decide(snap: SimSnapshot): DriveDecision[] {
      const out: DriveDecision[] = [];
      const planned = new Map<LaneId, number>();
      const lanes = new Map(snap.lanes.map((l) => [l.id, l]));
      for (const job of snap.queue) {
        const lane = lanes.get(job.pool);
        if (!lane || lane.paused) continue;
        const left = lane.freeSlots - (planned.get(lane.id) ?? 0);
        if (left <= 0) continue;
        planned.set(lane.id, (planned.get(lane.id) ?? 0) + 1);
        out.push({ kind: 'dispatch', jobId: job.id, lane: lane.id });
      }
      return out;
    },
  };
}

export function balancedPolicy(): DrivePolicy {
  return {
    name: 'balanced',
    decide(snap: SimSnapshot): DriveDecision[] {
      const out: DriveDecision[] = [];
      const planned = new Map<LaneId, number>();
      for (const job of snap.queue) {
        const left = spendable(snap.lanes, planned);
        const cands = candidates(job, snap.lanes, left);
        if (cands.length === 0) continue;
        // Least-loaded allowed lane; pool id breaks the tie deterministically.
        cands.sort((a, b) => {
          const fa = a.running / Math.max(1, a.ceiling);
          const fb = b.running / Math.max(1, b.ceiling);
          const pa = a.id === job.pool ? 0 : 1;
          const pb = b.id === job.pool ? 0 : 1;
          return fa - fb || pa - pb || (a.id < b.id ? -1 : 1);
        });
        const lane = cands[0];
        planned.set(lane.id, (planned.get(lane.id) ?? 0) + 1);
        out.push({ kind: 'dispatch', jobId: job.id, lane: lane.id });
      }
      return out;
    },
  };
}

export interface PaceFloorOptions {
  /**
   * A lane more than this far ahead of its pace target stops taking work
   * unless every allowed lane for the job is also past the line. 1.25 means
   * the lane may run at 125% of target before the policy steers work away.
   */
  maxPaceOverrun?: number;
  /** Pace is meaningless in the first minutes; the overrun rule waits this long. */
  paceGraceMs?: number;
}

export function paceFloorPolicy(opts: PaceFloorOptions = {}): DrivePolicy {
  const overrun = opts.maxPaceOverrun ?? 1.25;
  const graceMs = opts.paceGraceMs ?? 30 * 60_000;
  return {
    name: 'pace-floor',
    decide(snap: SimSnapshot): DriveDecision[] {
      const out: DriveDecision[] = [];
      const planned = new Map<LaneId, number>();
      // P0 first, then FIFO. queue is already FIFO, so a stable sort suffices.
      const jobs = [...snap.queue].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
      const over = (l: LaneView): boolean =>
        snap.elapsedMs >= graceMs && l.paceNowPerHour > l.pacePerHour * overrun;
      for (const job of jobs) {
        const left = spendable(snap.lanes, planned);
        let cands = candidates(job, snap.lanes, left).filter((l) => !over(l));
        if (cands.length === 0) cands = candidates(job, snap.lanes, left); // all ahead: run anyway
        if (cands.length === 0) continue;
        const behind = (l: LaneView) => l.paceNowPerHour < l.pacePerHour;
        cands.sort(
          (a, b) =>
            (a.belowFloor ? 0 : 1) - (b.belowFloor ? 0 : 1) ||
            (behind(a) ? 0 : 1) - (behind(b) ? 0 : 1) ||
            (a.id === job.pool ? 0 : 1) - (b.id === job.pool ? 0 : 1) ||
            a.busyFraction - b.busyFraction ||
            (a.id < b.id ? -1 : 1),
        );
        const lane = cands[0];
        planned.set(lane.id, (planned.get(lane.id) ?? 0) + 1);
        out.push({ kind: 'dispatch', jobId: job.id, lane: lane.id });
      }
      return out;
    },
  };
}
