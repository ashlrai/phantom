/**
 * drive-sim engine: a deterministic discrete-event simulator for `phm drive`
 * dispatch decisions.
 *
 * The simulated world is small on purpose:
 *
 *   - Queue ops (enqueue/cancel) arrive on their journaled timestamps.
 *   - Memguard ops pause/resume lanes. PAUSE freezes in-flight jobs where
 *     they stand: their remaining service is preserved and the completion is
 *     rescheduled on RESUME. A paused lane accepts no new dispatches.
 *   - Completions free a slot at service end.
 *   - Every `tickSec` the engine applies all events at that instant, then
 *     calls the policy once and applies its dispatch decisions in order.
 *
 * Determinism: events pop in (time, kind-rank, sequence) order; kinds rank
 * memguard < queue < completion < tick < end, so a tick sees the freshest
 * state. No wall clock, no RNG, no I/O: the same fixture and policy always
 * produce the same trace.
 */
import {
  allowedLanes,
  type LaneId,
  type LaneSpec,
  type QueueV1Enqueue,
  type SimInput,
} from './model.js';
import type { DriveDecision, DrivePolicy, LaneView, QueuedJobView, SimSnapshot } from './policy.js';

const MIN = 60_000;
const HOUR = 3_600_000;

// Event kinds in same-timestamp rank order. Memguard lands first so a tick at
// the pause instant already sees the lane stopped; the tick itself is last so
// decisions always run against fully applied state.
const RANK = { memguard: 0, queue: 1, complete: 2, tick: 3, end: 4 } as const;

type Event =
  | { t: number; rank: typeof RANK.memguard; seq: number; op: 'PAUSE' | 'RESUME'; lanes: LaneId[] }
  | { t: number; rank: typeof RANK.queue; seq: number; rec: QueueV1Enqueue | { kind: 'cancel'; id: string } }
  | { t: number; rank: typeof RANK.complete; seq: number; laneId: LaneId; jobId: string; cancelled: boolean }
  | { t: number; rank: typeof RANK.tick; seq: number; tick: number }
  | { t: number; rank: typeof RANK.end; seq: number };

function before(a: Event, b: Event): number {
  return a.t - b.t || a.rank - b.rank || a.seq - b.seq;
}

/** Binary min-heap keyed by (t, rank, seq). */
class Heap {
  private a: Event[] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: Event): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (before(a[p], e) <= 0) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = e;
  }
  pop(): Event | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    const n = a.length;
    if (n > 0) {
      // Sift `last` down: promote the smaller child until `last` fits.
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        if (l >= n) break;
        const c = r < n && before(a[r], a[l]) < 0 ? r : l;
        if (before(last, a[c]) <= 0) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
}

interface RunningJob {
  jobId: string;
  /** While unpaused: the ms time this job completes. */
  completesAtMs: number;
  /** While paused: service still owed to the job. */
  remainingMs: number;
  /** The pending completion event; cancelled on pause. */
  ev: Extract<Event, { rank: typeof RANK.complete }>;
}

export interface LaneRun {
  spec: LaneSpec;
  paused: boolean;
  running: Map<string, RunningJob>;
  busySlotMs: number;
  /** Slot-time occupied but frozen by memguard. */
  heldSlotMs: number;
  pausedMs: number;
  belowFloorMs: number;
  /** Below floor while a queued job could have used this lane. */
  floorStarvedMs: number;
  /** Completion timestamps on this lane. */
  completionsAt: number[];
}

export type JobState = 'queued' | 'running' | 'done' | 'cancelled' | 'leftover';

export interface JobRun {
  rec: QueueV1Enqueue;
  state: JobState;
  lane?: LaneId;
  enqueuedAtMs: number;
  dispatchedAtMs?: number;
  finishedAtMs?: number;
}

export interface AppliedDecision extends DriveDecision {
  tick: number;
  t: number;
}

export interface RejectedDecision extends DriveDecision {
  tick: number;
  t: number;
  reason:
    | 'unknown-job'
    | 'job-not-queued'
    | 'unknown-lane'
    | 'lane-paused'
    | 'lane-full'
    | 'lane-not-allowed';
}

export interface RunTrace {
  policy: string;
  startMs: number;
  endMs: number;
  tickMs: number;
  ticks: number;
  starveAfterMs: number;
  lanes: LaneRun[];
  /** In jobs.jsonl enqueue order. */
  jobs: JobRun[];
  applied: AppliedDecision[];
  rejected: RejectedDecision[];
  /** Cancel records for jobs that were not queued at the time. */
  ignoredCancels: { id: string; t: number }[];
}

/**
 * Replay one fixture day against a policy. Pure: no clock reads, no I/O.
 * Throws only on a structurally impossible input (the parsers catch bad
 * fixtures first); policy mistakes land in `rejected`, never as throws.
 */
export function runSimulation(input: SimInput, policy: DrivePolicy): RunTrace {
  const { status } = input;
  const startMs = Date.parse(status.startAt);
  const endMs = Date.parse(status.endAt);
  const tickMs = status.tickSec * 1000;
  const starveAfterMs = status.starveAfterMin * MIN;

  const lanes = new Map<LaneId, LaneRun>();
  for (const spec of status.lanes) {
    lanes.set(spec.id, {
      spec,
      paused: false,
      running: new Map(),
      busySlotMs: 0,
      heldSlotMs: 0,
      pausedMs: 0,
      belowFloorMs: 0,
      floorStarvedMs: 0,
      completionsAt: [],
    });
  }

  const jobs = new Map<string, JobRun>();
  const heap = new Heap();
  let seq = 0;

  for (const rec of input.jobs) {
    const t = Date.parse(rec.at);
    if (t < startMs || t >= endMs) continue; // outside the replayed day
    if (rec.kind === 'cancel') {
      heap.push({ t, rank: RANK.queue, seq: seq++, rec: { kind: 'cancel', id: rec.id } });
    } else {
      heap.push({ t, rank: RANK.queue, seq: seq++, rec });
    }
  }
  for (const op of status.memguard) {
    const t = Date.parse(op.at);
    if (t < startMs || t >= endMs) continue;
    heap.push({ t, rank: RANK.memguard, seq: seq++, op: op.op, lanes: [...op.lanes] });
  }
  for (let t = startMs, tick = 0; t < endMs; t += tickMs, tick++) {
    heap.push({ t, rank: RANK.tick, seq: seq++, tick });
  }
  heap.push({ t: endMs, rank: RANK.end, seq: seq++ });

  const applied: AppliedDecision[] = [];
  const rejected: RejectedDecision[] = [];
  const ignoredCancels: { id: string; t: number }[] = [];
  const queue: string[] = []; // job ids, FIFO

  const dispatchableFor = (laneId: LaneId): boolean =>
    queue.some((id) => allowedLanes(jobs.get(id)!.rec).includes(laneId));

  const accrue = (toMs: number, nowMs: number): number => {
    const dt = toMs - nowMs;
    if (dt > 0) {
      for (const lane of lanes.values()) {
        const n = lane.running.size;
        if (lane.paused) {
          lane.heldSlotMs += n * dt;
          lane.pausedMs += dt;
        } else {
          lane.busySlotMs += n * dt;
          if (n < lane.spec.floor) {
            lane.belowFloorMs += dt;
            if (dispatchableFor(lane.spec.id)) lane.floorStarvedMs += dt;
          }
        }
      }
    }
    return toMs;
  };

  let nowMs = startMs;
  let ticks = 0;

  const enqueueJob = (rec: QueueV1Enqueue, t: number): void => {
    if (jobs.has(rec.id)) return; // parser rejects dupes; belt and suspenders
    jobs.set(rec.id, { rec, state: 'queued', enqueuedAtMs: t });
    queue.push(rec.id);
  };

  const dequeue = (jobId: string): void => {
    const i = queue.indexOf(jobId);
    if (i >= 0) queue.splice(i, 1);
  };

  const pauseLane = (lane: LaneRun, t: number): void => {
    if (lane.paused) return;
    lane.paused = true;
    for (const r of lane.running.values()) {
      r.remainingMs = Math.max(0, r.completesAtMs - t);
      // A job whose service ends at the pause instant still completes: only
      // genuinely in-flight work freezes.
      if (r.remainingMs > 0) r.ev.cancelled = true;
    }
  };

  const resumeLane = (lane: LaneRun, t: number): void => {
    if (!lane.paused) return;
    lane.paused = false;
    for (const r of lane.running.values()) {
      r.completesAtMs = t + r.remainingMs;
      const ev: typeof r.ev = { t: r.completesAtMs, rank: RANK.complete, seq: seq++, laneId: lane.spec.id, jobId: r.jobId, cancelled: false };
      r.ev = ev;
      heap.push(ev);
    }
  };

  const applyDispatch = (d: DriveDecision, tick: number, t: number): void => {
    const reject = (reason: RejectedDecision['reason']): void => {
      rejected.push({ ...d, tick, t, reason });
    };
    const job = jobs.get(d.jobId);
    if (!job) return reject('unknown-job');
    if (job.state !== 'queued') return reject('job-not-queued');
    const lane = lanes.get(d.lane);
    if (!lane) return reject('unknown-lane');
    if (lane.paused) return reject('lane-paused');
    if (lane.running.size >= lane.spec.ceiling) return reject('lane-full');
    if (!allowedLanes(job.rec).includes(d.lane)) return reject('lane-not-allowed');

    dequeue(d.jobId);
    job.state = 'running';
    job.lane = d.lane;
    job.dispatchedAtMs = t;
    const serviceMs = job.rec.serviceMin * MIN;
    const ev: RunningJob['ev'] = { t: t + serviceMs, rank: RANK.complete, seq: seq++, laneId: d.lane, jobId: d.jobId, cancelled: false };
    lane.running.set(d.jobId, { jobId: d.jobId, completesAtMs: ev.t, remainingMs: serviceMs, ev });
    heap.push(ev);
    applied.push({ ...d, tick, t });
  };

  const snapshot = (tick: number, t: number): SimSnapshot => ({
    nowMs: t,
    tick,
    elapsedMs: t - startMs,
    remainingMs: endMs - t,
    starveAfterMs,
    lanes: status.lanes.map((spec) => {
      const lane = lanes.get(spec.id)!;
      const activeMs = Math.max(tickMs, t - startMs - lane.pausedMs);
      const paceNowPerHour = (lane.completionsAt.length / activeMs) * HOUR;
      return {
        id: spec.id,
        floor: spec.floor,
        ceiling: spec.ceiling,
        running: lane.running.size,
        freeSlots: spec.ceiling - lane.running.size,
        paused: lane.paused,
        completions: lane.completionsAt.length,
        pacePerHour: spec.pacePerHour,
        paceNowPerHour,
        belowFloor: lane.running.size < spec.floor,
        aheadOfPace: paceNowPerHour > spec.pacePerHour,
        busyFraction: spec.ceiling === 0 ? 0 : lane.running.size / spec.ceiling,
      } satisfies LaneView;
    }),
    queue: queue.map((id): QueuedJobView => {
      const j = jobs.get(id)!;
      return {
        id: j.rec.id,
        repo: j.rec.repo,
        pool: j.rec.pool,
        allowed: allowedLanes(j.rec),
        tier: j.rec.tier,
        priority: j.rec.priority ?? 'P1',
        enqueuedAtMs: j.enqueuedAtMs,
        waitMs: t - j.enqueuedAtMs,
        serviceMin: j.rec.serviceMin,
      };
    }),
  });

  for (;;) {
    const ev = heap.pop();
    if (!ev) break;
    nowMs = accrue(ev.t, nowMs);
    switch (ev.rank) {
      case RANK.memguard:
        for (const laneId of ev.lanes) {
          const lane = lanes.get(laneId);
          if (!lane) continue; // hand-built inputs may name a lane the day lacks
          if (ev.op === 'PAUSE') pauseLane(lane, ev.t);
          else resumeLane(lane, ev.t);
        }
        break;
      case RANK.queue:
        if (ev.rec.kind === 'cancel') {
          const job = jobs.get(ev.rec.id);
          if (job && job.state === 'queued') {
            job.state = 'cancelled';
            dequeue(job.rec.id);
          } else {
            ignoredCancels.push({ id: ev.rec.id, t: ev.t });
          }
        } else {
          enqueueJob(ev.rec, ev.t);
        }
        break;
      case RANK.complete: {
        if (ev.cancelled) break;
        const lane = lanes.get(ev.laneId)!;
        const job = jobs.get(ev.jobId)!;
        lane.running.delete(ev.jobId);
        lane.completionsAt.push(ev.t);
        job.state = 'done';
        job.finishedAtMs = ev.t;
        break;
      }
      case RANK.tick: {
        ticks++;
        const snap = snapshot(ev.tick, ev.t);
        const decisions = policy.decide(snap);
        if (Array.isArray(decisions)) {
          for (const d of decisions) applyDispatch(d, ev.tick, ev.t);
        }
        break;
      }
      case RANK.end:
        for (const job of jobs.values()) {
          if (job.state === 'queued') job.state = 'leftover';
        }
        break;
    }
    if (ev.rank === RANK.end) break;
  }

  return {
    policy: policy.name,
    startMs,
    endMs,
    tickMs,
    ticks,
    starveAfterMs,
    lanes: status.lanes.map((s) => lanes.get(s.id)!),
    jobs: [...jobs.values()],
    applied,
    rejected,
    ignoredCancels,
  };
}
