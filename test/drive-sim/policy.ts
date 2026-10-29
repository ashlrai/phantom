/**
 * drive-sim policy stub: the seam `phm drive` policies will implement.
 *
 * A policy is a pure function from a tick snapshot to a list of dispatch
 * decisions. It sees exactly what a real driver would know at a tick: the
 * queue in FIFO order, per-lane state (floor, ceiling, running, pause, pace),
 * and the clock. It cannot see the future; job service times are known only
 * as recorded `serviceMin` estimates.
 *
 * The only decision the stub models is `dispatch`: start job X on lane Y now.
 * Not deciding is a hold. The engine enforces physics (ceiling, pause,
 * allowLanes, single dispatch per job); decisions that violate physics are
 * rejected and recorded, which is how the harness surfaces policy bugs.
 */
import type { LaneId, Priority } from './model.js';

export interface LaneView {
  id: LaneId;
  floor: number;
  ceiling: number;
  /** Jobs occupying slots right now (still counted while frozen by a pause). */
  running: number;
  freeSlots: number;
  paused: boolean;
  /** Completions so far today. */
  completions: number;
  /** Target completions per hour from status.json. */
  pacePerHour: number;
  /** Observed completions per hour over the lane's unpaused time so far. */
  paceNowPerHour: number;
  /** True while running < floor. */
  belowFloor: boolean;
  /** True while paceNowPerHour exceeds pacePerHour. */
  aheadOfPace: boolean;
  busyFraction: number;
}

export interface QueuedJobView {
  id: string;
  repo?: string;
  /** Lane the router assigned. */
  pool: LaneId;
  /** Every lane this job may run on, pool first. */
  allowed: LaneId[];
  tier?: string;
  priority: Priority;
  enqueuedAtMs: number;
  /** How long the job has been waiting. */
  waitMs: number;
  /** Recorded service estimate in minutes. */
  serviceMin: number;
}

export interface SimSnapshot {
  /** Simulated clock at this tick, ms since epoch. */
  nowMs: number;
  /** Monotonic tick index, 0 on the first tick. */
  tick: number;
  elapsedMs: number;
  remainingMs: number;
  /** Queue wait longer than this counts as starvation. */
  starveAfterMs: number;
  lanes: LaneView[];
  /** FIFO order: oldest enqueued first. */
  queue: QueuedJobView[];
}

export type DriveDecision = { kind: 'dispatch'; jobId: string; lane: LaneId };

export interface DrivePolicy {
  readonly name: string;
  decide(snap: SimSnapshot): DriveDecision[];
}
