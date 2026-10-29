/**
 * drive-sim acceptance suite.
 *
 * Replays the fixture day (fixtures/jobs.jsonl + fixtures/status.json: the
 * queue.v1 stub and the frozen lane status for 2026-10-26) through the
 * discrete-event engine against three stub policies, and checks the numbers a
 * `phm drive` policy is judged on: lane utilization, starvation, pace versus
 * target, floor deficits. The fixture is built so the naive pool-loyal FIFO
 * starves two codex-personal jobs behind a long memguard pause while the
 * pace-floor policy spills them to allowed alternates and starves nothing.
 *
 * Everything here is test-only: the queue.v1 and DrivePolicy interfaces are
 * stubs for DRIVER-2/3/5, and no production code path is touched.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runSimulation } from './engine.js';
import { buildReport, formatReport, type SimReport } from './metrics.js';
import { parseFixture, parseJobsJsonl, parseStatusJson, type SimInput } from './model.js';
import { balancedPolicy, fifoPoolPolicy, paceFloorPolicy } from './policies.js';
import type { DrivePolicy } from './policy.js';

const MIN = 60_000;

function fixtureInput(): SimInput {
  const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
  return parseFixture(
    readFileSync(`${dir}jobs.jsonl`, 'utf8'),
    readFileSync(`${dir}status.json`, 'utf8'),
  );
}

function run(policy: DrivePolicy, input: SimInput = fixtureInput()): SimReport {
  return buildReport(runSimulation(input, policy));
}

function lane(rep: SimReport, id: string) {
  const l = rep.lanes.find((x) => x.id === id);
  if (!l) throw new Error(`lane ${id} missing from report`);
  return l;
}

describe('drive-sim fixtures', () => {
  it('parses the queue.v1 stub day: jobs.jsonl + status.json', () => {
    const input = fixtureInput();
    expect(input.jobs).toHaveLength(53);
    expect(input.jobs.filter((r) => r.kind === 'cancel')).toHaveLength(1);
    expect(input.status.lanes.map((l) => l.id)).toEqual(['codex-cmp', 'codex-personal', 'devin']);
    expect(input.status.memguard.filter((m) => m.op === 'PAUSE')).toHaveLength(3);
    expect(input.status.memguard.filter((m) => m.op === 'RESUME')).toHaveLength(3);
  });

  it('rejects malformed queue.v1 lines loudly', () => {
    expect(() => parseJobsJsonl('{"v":1,"id":"X","pool":"devin","at":"bad","serviceMin":5}')).toThrow(
      /bad timestamp/,
    );
    expect(() =>
      parseJobsJsonl('{"v":1,"id":"X","pool":"nope lane","at":"2026-10-26T06:00:00Z","serviceMin":5}'),
    ).toThrow(/bad pool/);
    expect(() =>
      parseStatusJson(
        '{"v":1,"startAt":"2026-10-26T06:00:00Z","endAt":"2026-10-26T07:00:00Z","tickSec":60,"starveAfterMin":30,"lanes":[{"id":"a","floor":2,"ceiling":1,"pacePerHour":1}]}',
      ),
    ).toThrow(/floor above ceiling/);
    expect(() =>
      parseJobsJsonl(
        '{"v":1,"id":"X","pool":"devin","at":"2026-10-26T06:00:00Z","serviceMin":5}\n' +
          '{"v":1,"id":"X","pool":"devin","at":"2026-10-26T06:01:00Z","serviceMin":5}',
      ),
    ).toThrow(/duplicate id/);
  });
});

describe('drive-sim fixture day: fifo-pool (naive baseline)', () => {
  const rep = run(fifoPoolPolicy());

  it('logs the day report', () => {
    console.log(formatReport(rep));
  });

  it('shows lane utilization for the fixture day', () => {
    // busy slot-time / (ceiling x 16h horizon), and the same with paused
    // hours divided out: a memguard-held lane is not blamed for lost time.
    expect(lane(rep, 'codex-cmp').utilization).toBeCloseTo(0.34375, 6);
    expect(lane(rep, 'codex-cmp').utilizationWhenAvailable).toBeCloseTo(0.3728813559322034, 6);
    expect(lane(rep, 'codex-personal').utilization).toBeCloseTo(0.3541666666666667, 6);
    expect(lane(rep, 'codex-personal').utilizationWhenAvailable).toBeCloseTo(0.4358974358974359, 6);
    expect(lane(rep, 'devin').utilization).toBeCloseTo(0.51171875, 6);
    // memguard: personal held 150m mid-morning + 30m evening, cmp 45m + 30m.
    expect(lane(rep, 'codex-personal').pausedMs).toBe(180 * MIN);
    expect(lane(rep, 'codex-cmp').pausedMs).toBe(75 * MIN);
    expect(lane(rep, 'devin').pausedMs).toBe(0);
    // Held slot-time: frozen in-flight jobs still occupy their slots.
    expect(lane(rep, 'codex-personal').heldSlotMs).toBe(150 * MIN);
  });

  it('shows starvation: two personal-lane jobs wait out the memguard pause', () => {
    expect(rep.starvation.starved).toEqual([
      { id: 'RQ-019', pool: 'codex-personal', waitMs: 195 * MIN, kind: 'late-start' },
      { id: 'RQ-021', pool: 'codex-personal', waitMs: 225 * MIN, kind: 'late-start' },
    ]);
    expect(rep.starvation.starvedCount).toBe(2);
    expect(rep.waits.p90Ms).toBe(35 * MIN);
    expect(rep.waits.maxMs).toBe(225 * MIN);
    expect(rep.jobs).toEqual({ arrived: 52, completed: 49, runningAtEnd: 2, queuedAtEnd: 0, cancelled: 1 });
  });

  it('shows pace numbers per lane', () => {
    // devin ran slightly under its 2/h target; personal could not be fed
    // enough to reach 1/h; cmp hovered just under.
    expect(lane(rep, 'devin').completions).toBe(28);
    expect(lane(rep, 'devin').paceRatio).toBeCloseTo(0.875, 6);
    expect(lane(rep, 'devin').paceWindowsMet).toBe(8);
    expect(lane(rep, 'codex-cmp').completions).toBe(14);
    expect(lane(rep, 'codex-cmp').paceWindowsMet).toBe(11);
    expect(lane(rep, 'codex-personal').completions).toBe(7);
    expect(lane(rep, 'codex-personal').paceWindowsMet).toBe(6);
  });

  it('shows floor deficits: cmp sat below its floor with usable work waiting', () => {
    // While RQ-019/RQ-021 were parked on the paused personal lane, cmp had
    // idle guaranteed slots those jobs were allowed to use; fifo never read
    // allowLanes, so the deficit accrued for 85 minutes.
    expect(lane(rep, 'codex-cmp').floorStarvedMs).toBe(85 * MIN);
    expect(lane(rep, 'codex-cmp').belowFloorMs).toBe(305 * MIN);
    expect(lane(rep, 'devin').floorStarvedMs).toBe(0);
  });

  it('applies every dispatch it proposed (a sane policy rejects nothing)', () => {
    expect(rep.decisions.rejected).toBe(0);
    expect(rep.decisions.applied).toBe(rep.jobs.completed + rep.jobs.runningAtEnd);
  });
});

describe('drive-sim fixture day: pace-floor (floors + pace aware)', () => {
  const rep = run(paceFloorPolicy());

  it('logs the day report', () => {
    console.log(formatReport(rep));
  });

  it('starves nothing: allowed alternates absorb the paused-lane work', () => {
    expect(rep.starvation.starvedCount).toBe(0);
    const r19 = rep.outcomes.find((o) => o.id === 'RQ-019');
    const r21 = rep.outcomes.find((o) => o.id === 'RQ-021');
    // The P0 hotfix and the job behind it moved to cmp within minutes.
    expect(r19?.lane).toBe('codex-cmp');
    expect(r21?.lane).toBe('codex-cmp');
    expect(r19?.waitMs).toBe(0);
    expect(r21?.waitMs).toBe(5 * MIN);
    // A pool-loyal job with no alternates still waits out the pause, but
    // inside the starvation bound.
    expect(rep.outcomes.find((o) => o.id === 'RQ-027')?.waitMs).toBe(55 * MIN);
  });

  it('beats fifo-pool on the numbers that matter', () => {
    const fifo = run(fifoPoolPolicy());
    const pace = rep;
    expect(pace.starvation.starvedCount).toBeLessThan(fifo.starvation.starvedCount);
    expect(pace.waits.p90Ms).toBeLessThan(fifo.waits.p90Ms);
    expect(pace.waits.p90Ms).toBe(7 * MIN);
    expect(pace.jobs.completed).toBe(fifo.jobs.completed);
    // More work landed: spills put three extra jobs through.
    expect(lane(pace, 'devin').completions).toBe(30);
    expect(lane(pace, 'codex-cmp').completions).toBe(15);
    // No floor starvation anywhere under pace-floor.
    for (const l of pace.lanes) expect(l.floorStarvedMs).toBe(0);
  });
});

describe('drive-sim fixture day: balanced (spill without pace sense)', () => {
  it('also fixes starvation but with a fatter wait tail', () => {
    const rep = run(balancedPolicy());
    console.log(formatReport(rep));
    expect(rep.starvation.starvedCount).toBe(0);
    // Same completions as pace-floor, worse tail: ignoring floors/pace costs
    // the queue fifteen minutes at p90 instead of seven.
    expect(rep.jobs.completed).toBe(49);
    expect(rep.waits.p90Ms).toBe(15 * MIN);
  });
});

describe('drive-sim determinism', () => {
  it('same fixture + same policy => identical report', () => {
    const a = run(paceFloorPolicy());
    const b = run(paceFloorPolicy());
    expect(a).toEqual(b);
  });
});

describe('drive-sim pace steering', () => {
  // L1 has already tripled its pace target when J-X lands: pace-floor steers
  // the spill-capable job to L2 rather than let L1 burn further ahead, while
  // a job with no alternate still runs (an idle lane beats a stranded job).
  const STEER: SimInput = {
    jobs: [
      { v: 1, at: '2026-10-26T06:00:00Z', id: 'W1', pool: 'L1', serviceMin: 5 },
      { v: 1, at: '2026-10-26T06:00:00Z', id: 'W2', pool: 'L1', serviceMin: 5 },
      { v: 1, at: '2026-10-26T06:00:00Z', id: 'W3', pool: 'L1', serviceMin: 5 },
      { v: 1, at: '2026-10-26T06:32:00Z', id: 'J-X', pool: 'L1', serviceMin: 20, allowLanes: ['L2'] },
      { v: 1, at: '2026-10-26T06:33:00Z', id: 'J-Y', pool: 'L1', serviceMin: 20 },
    ],
    status: {
      v: 1,
      day: '2026-10-26',
      startAt: '2026-10-26T06:00:00Z',
      endAt: '2026-10-26T10:00:00Z',
      tickSec: 60,
      starveAfterMin: 180,
      lanes: [
        { id: 'L1', floor: 0, ceiling: 1, pacePerHour: 1 },
        { id: 'L2', floor: 0, ceiling: 1, pacePerHour: 1 },
      ],
      memguard: [],
    },
  };

  it('pace-floor steers an over-pace lane spill to the alternate', () => {
    const rep = run(paceFloorPolicy(), STEER);
    expect(rep.outcomes.find((o) => o.id === 'J-X')?.lane).toBe('L2');
    expect(rep.outcomes.find((o) => o.id === 'J-Y')?.lane).toBe('L1');
  });

  it('fifo-pool is blind to the steer and runs J-X on L1', () => {
    const rep = run(fifoPoolPolicy(), STEER);
    expect(rep.outcomes.find((o) => o.id === 'J-X')?.lane).toBe('L1');
  });
});

describe('drive-sim engine physics', () => {
  const DAY: SimInput = {
    jobs: [
      { v: 1, at: '2026-10-26T06:00:00Z', id: 'J-A', pool: 'L1', serviceMin: 60 },
      { v: 1, at: '2026-10-26T06:00:00Z', id: 'J-B', pool: 'L1', serviceMin: 30 },
    ],
    status: {
      v: 1,
      day: '2026-10-26',
      startAt: '2026-10-26T06:00:00Z',
      endAt: '2026-10-26T12:00:00Z',
      tickSec: 60,
      starveAfterMin: 180,
      lanes: [{ id: 'L1', floor: 0, ceiling: 1, pacePerHour: 1 }],
      memguard: [
        { at: '2026-10-26T06:10:00Z', op: 'PAUSE', lanes: ['L1'] },
        { at: '2026-10-26T06:40:00Z', op: 'RESUME', lanes: ['L1'] },
      ],
    },
  };

  it('PAUSE freezes a running job: wall time stretches, busy time does not', () => {
    const rep = run(fifoPoolPolicy(), DAY);
    const a = rep.outcomes.find((o) => o.id === 'J-A');
    // 10m active, frozen 30m, then the remaining 50m: done at 07:30.
    expect(a?.state).toBe('done');
    expect(a?.serviceWallMs).toBe(90 * MIN);
    const l = lane(rep, 'L1');
    // Busy slot-time counts only active work: 60m for A plus 30m for B.
    expect(l.busySlotMs).toBe(90 * MIN);
    expect(l.heldSlotMs).toBe(30 * MIN);
    expect(l.pausedMs).toBe(30 * MIN);
    expect(l.utilizationWhenAvailable).toBeCloseTo(90 / (6 * 60 - 30), 6);
  });

  it('rejects dispatches that break physics and keeps going', () => {
    const bad: DrivePolicy = {
      name: 'chaos',
      decide: (snap) => {
        const first = snap.queue[0];
        if (!first) return [];
        return [
          { kind: 'dispatch', jobId: first.id, lane: 'nowhere' },
          { kind: 'dispatch', jobId: 'GHOST', lane: 'L1' },
          { kind: 'dispatch', jobId: first.id, lane: 'L1' },
          { kind: 'dispatch', jobId: first.id, lane: 'L1' },
        ];
      },
    };
    const rep = run(bad, DAY);
    expect(rep.decisions.rejectionsByReason['unknown-lane']).toBeGreaterThan(0);
    expect(rep.decisions.rejectionsByReason['unknown-job']).toBeGreaterThan(0);
    expect(rep.decisions.rejectionsByReason['job-not-queued']).toBeGreaterThan(0);
    // The run still completed both jobs.
    expect(rep.jobs.completed).toBe(2);
  });

  it('rejects lane-full, lane-paused and lane-not-allowed dispatches', () => {
    const greedy = (laneId: string): DrivePolicy => ({
      name: 'greedy',
      decide: (snap) => snap.queue.map((j) => ({ kind: 'dispatch' as const, jobId: j.id, lane: laneId })),
    });
    const input: SimInput = {
      jobs: [
        { v: 1, at: '2026-10-26T06:00:00Z', id: 'A', pool: 'L1', serviceMin: 60 },
        { v: 1, at: '2026-10-26T06:00:00Z', id: 'B', pool: 'L1', serviceMin: 60 },
        { v: 1, at: '2026-10-26T06:00:00Z', id: 'C', pool: 'L2', serviceMin: 60 },
      ],
      status: {
        v: 1,
        day: '2026-10-26',
        startAt: '2026-10-26T06:00:00Z',
        endAt: '2026-10-26T12:00:00Z',
        tickSec: 60,
        starveAfterMin: 180,
        lanes: [
          { id: 'L1', floor: 0, ceiling: 1, pacePerHour: 1 },
          { id: 'L2', floor: 0, ceiling: 1, pacePerHour: 1 },
        ],
        memguard: [{ at: '2026-10-26T08:00:00Z', op: 'PAUSE', lanes: ['L2'] }],
      },
    };
    const rep = run(greedy('L1'), input);
    // C is never allowed on L1; every tick also tries to overfill L1.
    expect(rep.decisions.rejectionsByReason['lane-not-allowed']).toBeGreaterThan(0);
    expect(rep.decisions.rejectionsByReason['lane-full']).toBeGreaterThan(0);
    // C never ran: it ends the day still queued.
    expect(rep.outcomes.find((o) => o.id === 'C')?.state).toBe('leftover');
    const rep2 = run(greedy('L2'), input);
    expect(rep2.decisions.rejectionsByReason['lane-paused']).toBeGreaterThan(0);
  });

  it('a cancel removes a queued job and is ignored for running or unknown jobs', () => {
    const input: SimInput = {
      jobs: [
        { v: 1, at: '2026-10-26T06:00:00Z', id: 'A', pool: 'L1', serviceMin: 120 },
        { v: 1, at: '2026-10-26T06:05:00Z', id: 'B', pool: 'L1', serviceMin: 30 },
        { v: 1, kind: 'cancel', at: '2026-10-26T06:30:00Z', id: 'A' },
        { v: 1, kind: 'cancel', at: '2026-10-26T06:30:00Z', id: 'B' },
        { v: 1, kind: 'cancel', at: '2026-10-26T06:30:00Z', id: 'GHOST' },
      ],
      status: {
        v: 1,
        day: '2026-10-26',
        startAt: '2026-10-26T06:00:00Z',
        endAt: '2026-10-26T12:00:00Z',
        tickSec: 60,
        starveAfterMin: 180,
        lanes: [{ id: 'L1', floor: 0, ceiling: 1, pacePerHour: 1 }],
        memguard: [],
      },
    };
    const trace = runSimulation(input, fifoPoolPolicy());
    const rep = buildReport(trace);
    expect(rep.outcomes.find((o) => o.id === 'A')?.state).toBe('done');
    expect(rep.outcomes.find((o) => o.id === 'B')?.state).toBe('cancelled');
    expect(trace.ignoredCancels.map((c) => c.id).sort()).toEqual(['A', 'GHOST']);
  });
});

describe('drive-sim performance', () => {
  it('replays the fixture day far under the 60s budget', () => {
    const t0 = Date.now();
    for (const p of [fifoPoolPolicy(), balancedPolicy(), paceFloorPolicy()]) run(p);
    expect(Date.now() - t0).toBeLessThan(60_000);
  });
});
