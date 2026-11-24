import { describe, expect, it } from 'vitest';
import {
  RECORDED_ASSIGNMENT_RUNWAY_PROVENANCE,
  recordedAssignmentRunway,
  type RecordedAssignmentRunwayInput,
  type RecordedAssignmentRunwayKnown,
} from '../src/core/providers/coding-cli/recorded-assignment-runway.js';

const H = 3_600_000;
const base: RecordedAssignmentRunwayInput = {
  poolId: 'pool-a',
  asOfMs: 1_000_000,
  resetAtMs: 1_000_000 + 10 * H,
  remainingFraction: 0.5,
  paceTickMs: 2 * H,
  demands: [{ poolId: 'pool-a', demand: 0.1 }],
};
const known = (over: Partial<RecordedAssignmentRunwayInput> = {}): RecordedAssignmentRunwayKnown => {
  const r = recordedAssignmentRunway({ ...base, ...over });
  if (r.status !== 'known') throw new Error('expected known');
  return r;
};

describe('recordedAssignmentRunway (PR #5952 recovery)', () => {
  it('hand-calculates positive spend and labels it historical', () => {
    const r = known();
    // ((0.5-0.1)/0.1) * 2h = 8h
    expect(r.runwayHours).toBeCloseTo(8, 10);
    expect(r.spentFraction).toBeCloseTo(0.1, 12);
    expect(r.timeLeftHours).toBe(10);
    expect(r.basis).toBe('burn-rate-estimate');
    expect(r.exhaustsAllowance).toBe(false);
    expect(r.liveQuota).toBe(false);
    expect(r.kind).toBe('historical-recorded-assignment-runway');
    expect(r.poolId).toBe('pool-a');
    expect(r.evidence).toEqual({ asOfMs: 1_000_000, resetAtMs: 1_000_000 + 10 * H, remainingFraction: 0.5, paceTickMs: 2 * H });
    expect(r.provenance).toEqual(RECORDED_ASSIGNMENT_RUNWAY_PROVENANCE);
    expect(r.provenance.sourcePr).toBe(5952);
    expect(r.provenance.sourceSha).toBe('3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886');
  });

  it('sums multiple selected-pool rows and ignores other pools', () => {
    const r = known({
      demands: [
        { poolId: 'pool-a', demand: 0.1 },
        { poolId: 'pool-b', demand: 0.9 },
        { poolId: 'pool-a', demand: 0.15 },
      ],
    });
    expect(r.spentFraction).toBeCloseTo(0.25, 12);
    expect(r.runwayHours).toBeCloseTo(((0.5 - 0.25) / 0.25) * 2, 10);
  });

  it('zero spend returns the time-to-reset fallback, not a burn estimate', () => {
    for (const demands of [[], [{ poolId: 'pool-b', demand: 0.4 }], [{ poolId: 'pool-a', demand: 0 }]]) {
      const r = known({ demands });
      expect(r.basis).toBe('time-to-reset-fallback');
      expect(r.runwayHours).toBe(10);
      expect(r.exhaustsAllowance).toBe(false);
    }
    // pace is not needed on the fallback path
    expect(known({ demands: [], paceTickMs: null }).runwayHours).toBe(10);
  });

  it('treats spend at or below 1e-12 as zero and just above as burn', () => {
    expect(known({ demands: [{ poolId: 'pool-a', demand: 1e-12 }] }).basis).toBe('time-to-reset-fallback');
    const r = known({ demands: [{ poolId: 'pool-a', demand: 2e-12 }] });
    expect(r.basis).toBe('burn-rate-estimate');
    expect(r.runwayHours).toBeGreaterThan(10); // huge, exceeds time to reset
  });

  it('batch at or beyond remaining allowance gives zero runway and flags exhaustion', () => {
    const at = known({ demands: [{ poolId: 'pool-a', demand: 0.5 }] });
    expect(at.runwayHours).toBe(0);
    expect(at.exhaustsAllowance).toBe(true);
    const over = known({ demands: [{ poolId: 'pool-a', demand: 0.8 }] });
    expect(over.runwayHours).toBe(0);
    expect(over.exhaustsAllowance).toBe(true);
  });

  it('elapsed reset gives zero hours to reset', () => {
    const past = known({ resetAtMs: 1_000_000 - H, demands: [] });
    expect(past.timeLeftHours).toBe(0);
    expect(past.runwayHours).toBe(0);
    expect(known({ resetAtMs: 1_000_000 - H }).timeLeftHours).toBe(0);
  });

  it('positive burn runway can exceed hours to reset', () => {
    const r = known({ remainingFraction: 1, paceTickMs: 6 * H, demands: [{ poolId: 'pool-a', demand: 0.05 }] });
    expect(r.runwayHours).toBeCloseTo(19 * 6, 9);
    expect(r.runwayHours).toBeGreaterThan(r.timeLeftHours);
  });

  it('matches the original arithmetic on fake recorded data', () => {
    // Transcription of source runwayHours() with fake data.
    const nowMs = 5_000_000;
    const resetAtMs = nowMs + 36 * H;
    const remaining = 0.62;
    const paceTickMs = 90 * 60_000;
    const rows = [
      { poolId: 'fake-weekly', demand: 0.07 },
      { poolId: 'other', demand: 0.5 },
      { poolId: 'fake-weekly', demand: 0.11 },
    ];
    const spent = rows.filter((x) => x.poolId === 'fake-weekly').reduce((s, x) => s + x.demand, 0);
    const original =
      spent <= 1e-12 ? Math.max(0, resetAtMs - nowMs) / 3_600_000 : Math.max(0, ((remaining - spent) / spent) * (paceTickMs / 3_600_000));
    const r = known({ poolId: 'fake-weekly', asOfMs: nowMs, resetAtMs, remainingFraction: remaining, paceTickMs, demands: rows });
    expect(r.runwayHours).toBe(original);
  });

  it('returns explicit unknown (never zero) for missing evidence', () => {
    for (const field of ['asOfMs', 'resetAtMs', 'remainingFraction', 'demands'] as const) {
      for (const v of [null, undefined]) {
        const r = recordedAssignmentRunway({ ...base, [field]: v });
        expect(r.status).toBe('unknown');
        if (r.status === 'unknown') expect(r.missing).toEqual([field]);
        expect(r).not.toHaveProperty('runwayHours');
        expect(r.liveQuota).toBe(false);
        expect(r.provenance.sourcePr).toBe(5952);
      }
    }
    const noPace = recordedAssignmentRunway({ ...base, paceTickMs: undefined });
    expect(noPace.status === 'unknown' && noPace.missing).toEqual(['paceTickMs']);
    const all = recordedAssignmentRunway({ poolId: 'pool-a' });
    expect(all.status === 'unknown' && all.missing).toEqual(['asOfMs', 'resetAtMs', 'remainingFraction', 'demands']);
  });

  it('rejects invalid numeric inputs', () => {
    const bad: Partial<RecordedAssignmentRunwayInput>[] = [
      { asOfMs: NaN },
      { asOfMs: Infinity },
      { resetAtMs: -Infinity },
      { remainingFraction: NaN },
      { remainingFraction: -0.01 },
      { remainingFraction: 1.01 },
      { paceTickMs: 0 },
      { paceTickMs: -1 },
      { paceTickMs: NaN },
      { demands: [{ poolId: 'pool-a', demand: NaN }] },
      { demands: [{ poolId: 'pool-a', demand: -0.1 }] },
      { demands: [{ poolId: 'pool-b', demand: Infinity }] },
      { poolId: '' },
    ];
    for (const over of bad) expect(() => recordedAssignmentRunway({ ...base, ...over })).toThrow(RangeError);
    // bad data is not masked by unrelated missing evidence
    expect(() => recordedAssignmentRunway({ ...base, demands: null, remainingFraction: 2 })).toThrow(RangeError);
  });
});
