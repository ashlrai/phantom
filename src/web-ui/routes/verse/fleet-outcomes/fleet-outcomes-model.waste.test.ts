import { describe, expect, it } from 'vitest';
import { readOutcomes, wasteLine, wasteSummary, type OutcomeCaseRow } from './fleet-outcomes-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const row = (n: number, outcome: OutcomeCaseRow['outcome'], lane?: string): OutcomeCaseRow => ({
  caseId: `fake-${n}`, endedAt: '2026-10-31T11:00:00Z', outcome, label: outcome,
  failureKind: null, proposalRecorded: false, jobId: null, prLink: null, lane,
});

describe('waste summary', () => {
  it('summarizes 40 finished cases and ranks the lanes of wasted cases', () => {
    const cases = Array.from({ length: 40 }, (_, n) => row(n,
      n < 7 ? 'empty-diff' : n < 10 ? 'refused' : n < 12 ? 'failed' : 'producer-succeeded',
      n < 8 ? 'codex-personal' : 'other'));
    const summary = wasteSummary(cases, now);
    expect(summary).toEqual({ window: 24, finished: 40, wasted: 12,
      byOutcome: { 'empty-diff': 7, refused: 3, failed: 2 },
      byLane: [{ lane: 'codex-personal', wasted: 8 }, { lane: 'other', wasted: 4 }] });
    expect(wasteLine(summary)).toBe('Waste, last 24 h: 12 of 40 finished cases produced nothing (7 empty diff, 3 refused, 2 failed). Most on codex-personal (8).');
  });

  it('excludes old, future, missing and invalid timestamps when any end time is present', () => {
    const cases = [row(1, 'cancelled'),
      { ...row(2, 'failed'), endedAt: '2026-10-30T11:59:59Z' },
      { ...row(3, 'failed'), endedAt: '2026-10-31T12:00:01Z' },
      { ...row(4, 'failed'), endedAt: null }, { ...row(5, 'failed'), endedAt: 'invalid' },
      { ...row(6, 'producer-succeeded'), endedAt: '2026-10-30T12:00:00Z' }];
    expect(wasteSummary(cases, now)).toMatchObject({ finished: 2, wasted: 1, byOutcome: { cancelled: 1 } });
    expect(wasteLine(wasteSummary(cases, now))).toContain('Lane or producer not recorded (1).');
  });

  it('falls back to all cases without end times and returns null for zero finished', () => {
    const summary = wasteSummary([{ ...row(1, 'failed'), endedAt: null }, { ...row(2, 'disabled'), endedAt: null }], now);
    expect(summary).toMatchObject({ window: 0, finished: 2, wasted: 1 });
    expect(wasteLine(summary)).toBe('Waste, all available cases: 1 of 2 finished cases produced nothing (1 failed). Lane or producer not recorded (1).');
    expect(wasteLine(wasteSummary([], now))).toBeNull();
    expect(wasteLine(wasteSummary([{ ...row(1, 'failed'), endedAt: '2026-10-29T00:00:00Z' }], now))).toBeNull();
  });

  it('preserves optional lane and producer metadata from the feedback cases', () => {
    const view = readOutcomes({ v: 1, state: 'current', feedback: { sourceState: 'healthy', cases: [
      { caseId: 'fake-1', outcome: 'failed', endedAt: '2026-10-31T11:00:00Z', producer: 'worker-a' },
      { caseId: 'fake-2', outcome: 'empty-diff', endedAt: '2026-10-31T11:00:00Z', lane: 'lane-b' },
    ] } })!;
    expect(wasteSummary(view.cases, now).byLane).toEqual([{ lane: 'lane-b', wasted: 1 }, { lane: 'producer worker-a', wasted: 1 }]);
  });
});
