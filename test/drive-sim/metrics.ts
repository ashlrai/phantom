/**
 * drive-sim metrics: turn a run trace into the numbers a `phm drive` policy
 * is judged on.
 *
 *   - utilization:      busy slot-time / (ceiling x horizon). A lane at 1.0
 *                       ran flat out all day; `utilizationWhenAvailable`
 *                       divides out paused time instead, so a memguard-held
 *                       lane is not blamed for hours it could not use.
 *   - starvation:       queue waits past `starveAfterMs`, plus jobs that never
 *                       started at all once the day ended.
 *   - pace:             completions per active hour against the lane's target,
 *                       plus how many full hour-windows met it.
 *   - floors:           time a lane ran below its guaranteed floor, and the
 *                       subset where queued work could have used the idle
 *                       guaranteed slots (a real policy failure).
 */
import type { LaneId } from './model.js';
import type { RunTrace } from './engine.js';

const HOUR = 3_600_000;

export interface LaneReport {
  id: LaneId;
  floor: number;
  ceiling: number;
  pacePerHour: number;
  pausedMs: number;
  busySlotMs: number;
  heldSlotMs: number;
  utilization: number;
  utilizationWhenAvailable: number;
  completions: number;
  perActiveHour: number;
  paceRatio: number;
  /** Full hour-windows of the day. */
  paceWindows: number;
  /** Windows whose completions met or beat pacePerHour. */
  paceWindowsMet: number;
  belowFloorMs: number;
  floorStarvedMs: number;
}

export type JobOutcomeState = 'done' | 'runningAtEnd' | 'leftover' | 'cancelled';

export interface JobOutcome {
  id: string;
  pool: LaneId;
  lane?: LaneId;
  priority: string;
  state: JobOutcomeState;
  waitMs: number | null;
  /** Wall time from dispatch to completion, including frozen time. */
  serviceWallMs: number | null;
}

export interface StarvedJob {
  id: string;
  pool: LaneId;
  waitMs: number;
  /** 'late-start' ran but waited too long; 'never-started' never dispatched. */
  kind: 'late-start' | 'never-started';
}

export interface WaitStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
}

export interface SimReport {
  policy: string;
  startAt: string;
  endAt: string;
  horizonMs: number;
  ticks: number;
  jobs: {
    arrived: number;
    completed: number;
    runningAtEnd: number;
    queuedAtEnd: number;
    cancelled: number;
  };
  waits: WaitStats;
  starvation: {
    thresholdMs: number;
    starvedCount: number;
    starved: StarvedJob[];
  };
  lanes: LaneReport[];
  decisions: {
    proposed: number;
    applied: number;
    rejected: number;
    rejectionsByReason: Record<string, number>;
  };
  outcomes: JobOutcome[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function buildReport(trace: RunTrace): SimReport {
  const horizonMs = trace.endMs - trace.startMs;

  const outcomes: JobOutcome[] = trace.jobs.map((j) => {
    const state: JobOutcomeState =
      j.state === 'done' ? 'done'
      : j.state === 'running' ? 'runningAtEnd'
      : j.state === 'cancelled' ? 'cancelled'
      : 'leftover';
    return {
      id: j.rec.id,
      pool: j.rec.pool,
      lane: j.lane,
      priority: j.rec.priority ?? 'P1',
      state,
      waitMs: j.dispatchedAtMs === undefined ? null : j.dispatchedAtMs - j.enqueuedAtMs,
      serviceWallMs:
        j.dispatchedAtMs === undefined || j.finishedAtMs === undefined
          ? null
          : j.finishedAtMs - j.dispatchedAtMs,
    };
  });

  const waits = outcomes.filter((o) => o.waitMs !== null).map((o) => o.waitMs as number);
  waits.sort((a, b) => a - b);
  const waitStats: WaitStats = {
    count: waits.length,
    meanMs: waits.length === 0 ? 0 : waits.reduce((a, b) => a + b, 0) / waits.length,
    p50Ms: percentile(waits, 50),
    p90Ms: percentile(waits, 90),
    maxMs: waits.length === 0 ? 0 : waits[waits.length - 1],
  };

  const starved: StarvedJob[] = [];
  for (const [i, j] of trace.jobs.entries()) {
    const o = outcomes[i];
    if (o.state === 'done' || o.state === 'runningAtEnd') {
      if ((o.waitMs as number) > trace.starveAfterMs) {
        starved.push({ id: o.id, pool: o.pool, waitMs: o.waitMs as number, kind: 'late-start' });
      }
    } else if (o.state === 'leftover') {
      const waited = trace.endMs - j.enqueuedAtMs;
      if (waited > trace.starveAfterMs) {
        starved.push({ id: o.id, pool: o.pool, waitMs: waited, kind: 'never-started' });
      }
    }
  }

  const lanes: LaneReport[] = trace.lanes.map((lane) => {
    const spec = lane.spec;
    const availableMs = horizonMs - lane.pausedMs;
    const windows = Math.floor(horizonMs / HOUR);
    const buckets = new Array<number>(windows).fill(0);
    for (const t of lane.completionsAt) {
      const b = Math.floor((t - trace.startMs) / HOUR);
      if (b >= 0 && b < windows) buckets[b]++;
    }
    const paceWindowsMet = buckets.filter((c) => c >= spec.pacePerHour).length;
    const perActiveHour = availableMs > 0 ? (lane.completionsAt.length / availableMs) * HOUR : 0;
    return {
      id: spec.id,
      floor: spec.floor,
      ceiling: spec.ceiling,
      pacePerHour: spec.pacePerHour,
      pausedMs: lane.pausedMs,
      busySlotMs: lane.busySlotMs,
      heldSlotMs: lane.heldSlotMs,
      utilization: spec.ceiling === 0 ? 0 : lane.busySlotMs / (spec.ceiling * horizonMs),
      utilizationWhenAvailable:
        spec.ceiling === 0 || availableMs <= 0 ? 0 : lane.busySlotMs / (spec.ceiling * availableMs),
      completions: lane.completionsAt.length,
      perActiveHour,
      paceRatio: spec.pacePerHour === 0 ? 0 : perActiveHour / spec.pacePerHour,
      paceWindows: windows,
      paceWindowsMet,
      belowFloorMs: lane.belowFloorMs,
      floorStarvedMs: lane.floorStarvedMs,
    };
  });

  const rejectionsByReason: Record<string, number> = {};
  for (const r of trace.rejected) {
    rejectionsByReason[r.reason] = (rejectionsByReason[r.reason] ?? 0) + 1;
  }

  return {
    policy: trace.policy,
    startAt: new Date(trace.startMs).toISOString(),
    endAt: new Date(trace.endMs).toISOString(),
    horizonMs,
    ticks: trace.ticks,
    jobs: {
      arrived: trace.jobs.length,
      completed: outcomes.filter((o) => o.state === 'done').length,
      runningAtEnd: outcomes.filter((o) => o.state === 'runningAtEnd').length,
      queuedAtEnd: outcomes.filter((o) => o.state === 'leftover').length,
      cancelled: outcomes.filter((o) => o.state === 'cancelled').length,
    },
    waits: waitStats,
    starvation: {
      thresholdMs: trace.starveAfterMs,
      starvedCount: starved.length,
      starved,
    },
    lanes,
    decisions: {
      proposed: trace.applied.length + trace.rejected.length,
      applied: trace.applied.length,
      rejected: trace.rejected.length,
      rejectionsByReason,
    },
    outcomes,
  };
}

const min = (ms: number): string => `${Math.round(ms / 60_000)}m`;
const pct = (f: number): string => `${(f * 100).toFixed(1)}%`;

/** Compact fixed-width rendering; tests log it so the numbers stay visible. */
export function formatReport(rep: SimReport): string {
  const lines: string[] = [];
  lines.push(`drive-sim report  policy=${rep.policy}  day=${rep.startAt.slice(0, 10)}  ticks=${rep.ticks}`);
  lines.push(
    `jobs: arrived=${rep.jobs.arrived} completed=${rep.jobs.completed} ` +
      `runningAtEnd=${rep.jobs.runningAtEnd} queuedAtEnd=${rep.jobs.queuedAtEnd} cancelled=${rep.jobs.cancelled}`,
  );
  const w = rep.waits;
  lines.push(
    `waits: n=${w.count} mean=${min(w.meanMs)} p50=${min(w.p50Ms)} p90=${min(w.p90Ms)} max=${min(w.maxMs)}`,
  );
  lines.push(
    `starved (>${min(rep.starvation.thresholdMs)}): ${rep.starvation.starvedCount}` +
      (rep.starvation.starved.length === 0
        ? ''
        : '  ' +
          rep.starvation.starved.map((s) => `${s.id} ${s.kind} ${min(s.waitMs)}`).join('; ')),
  );
  lines.push('lane            ceil  util   utilAvail  paused   done  /h     pace  ratio  winMet  belowFloor floorStarv');
  for (const l of rep.lanes) {
    lines.push(
      [
        l.id.padEnd(15),
        String(l.ceiling).padStart(4),
        pct(l.utilization).padStart(7),
        pct(l.utilizationWhenAvailable).padStart(10),
        min(l.pausedMs).padStart(7),
        String(l.completions).padStart(5),
        l.perActiveHour.toFixed(2).padStart(6),
        l.pacePerHour.toFixed(2).padStart(6),
        l.paceRatio.toFixed(2).padStart(6),
        `${l.paceWindowsMet}/${l.paceWindows}`.padStart(6),
        min(l.belowFloorMs).padStart(10),
        min(l.floorStarvedMs).padStart(10),
      ].join(' '),
    );
  }
  const d = rep.decisions;
  lines.push(
    `decisions: proposed=${d.proposed} applied=${d.applied} rejected=${d.rejected}` +
      (d.rejected === 0
        ? ''
        : `  (${Object.entries(d.rejectionsByReason)
            .map(([k, n]) => `${k}=${n}`)
            .join(', ')})`),
  );
  return lines.join('\n');
}
