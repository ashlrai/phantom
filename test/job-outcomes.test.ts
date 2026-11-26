import { describe, expect, it } from 'vitest';
import { collapseJobOutcomes, parseJobOutcomeRows } from '../src/core/queue/job-outcomes.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const row = (fields: object) => JSON.stringify({ ts: '2026-11-09T10:00:00Z', ...fields });

describe('parseJobOutcomeRows', () => {
  it('reads finish and outcome rows; skips malformed lines and out-of-window rows', () => {
    const rows = parseJobOutcomeRows([
      row({ job: 'RQ-A', event: 'finish', empty: true, diff_lines: 0 }),
      row({ job: 'RQ-B', event: 'outcome', state: 'MERGED' }),
      row({ job: 'RQ-C', empty: false }),
      row({ job: 'RQ-WIKI', event: 'wiki_slice', wikiSlice: { bytes: 220 } }),
      '{broken', 'not json',
      JSON.stringify({ job: 'RQ-NODATE' }),
      JSON.stringify({ ts: '2026-11-01T00:00:00Z', job: 'RQ-OLD', empty: true }),
      JSON.stringify({ ts: '2026-11-10T00:00:00Z', job: 'RQ-FUTURE', empty: true }),
      JSON.stringify([1, 2]),
    ].join('\n'), NOW, DAY);
    expect(rows).toEqual([
      { job: 'RQ-A', at: Date.parse('2026-11-09T10:00:00Z'), empty: true, merged: false },
      { job: 'RQ-B', at: Date.parse('2026-11-09T10:00:00Z'), empty: false, merged: true },
      { job: 'RQ-C', at: Date.parse('2026-11-09T10:00:00Z'), empty: false, merged: false },
    ]);
  });

  it('treats terminal empty markers as empty and honours timestamp aliases', () => {
    const rows = parseJobOutcomeRows([
      JSON.stringify({ timestamp: '2026-11-09T10:00:00Z', job_id: 'J1', outcome: 'DONE-NOOP' }),
      JSON.stringify({ at: '2026-11-09T10:30:00Z', jobId: 'J2', outcome: 'empty' }),
    ].join('\n'), NOW, DAY);
    expect(rows.map((r) => [r.job, r.empty])).toEqual([['J1', true], ['J2', true]]);
  });

  it('reads the production ledger dialects: status phases, id jobs, terminal stamps', () => {
    const rows = parseJobOutcomeRows([
      // metrics-outcomes reconciler row copied from a status-dialect PUBLISHED row
      JSON.stringify({ event: 'publish', job: 'RQ-M1', status: 'MERGED', ts: '2026-11-09T09:00:00Z', mergedAt: '2026-11-09T08:00:00Z' }),
      // eventless outcome row on the id alias with only mergedAt
      JSON.stringify({ id: 'RQ-M2', outcome: 'MERGED', mergedAt: '2026-11-09T10:00:00Z' }),
      // type/kind event aliases with a closedAt stamp
      JSON.stringify({ type: 'outcome', job: 'RQ-M3', status: 'CLOSED', closedAt: '2026-11-09T10:30:00Z' }),
      // a malformed preferred stamp falls through to the next parseable field
      JSON.stringify({ job: 'RQ-M4', state: 'MERGED', mergedAt: 'not a date', ts: '2026-11-09T11:00:00Z' }),
    ].join('\n'), NOW, DAY);
    expect(rows).toEqual([
      { job: 'RQ-M1', at: Date.parse('2026-11-09T08:00:00Z'), empty: false, merged: true },
      { job: 'RQ-M2', at: Date.parse('2026-11-09T10:00:00Z'), empty: false, merged: true },
      { job: 'RQ-M3', at: Date.parse('2026-11-09T10:30:00Z'), empty: null, merged: false },
      { job: 'RQ-M4', at: Date.parse('2026-11-09T11:00:00Z'), empty: false, merged: true },
    ]);
  });

  it('reads phase, result and conclusion outcome spellings', () => {
    const rows = parseJobOutcomeRows([
      JSON.stringify({ event: 'outcome', job: 'RQ-P1', phase: 'MERGED', ts: '2026-11-09T10:00:00Z' }),
      JSON.stringify({ event: 'outcome', job: 'RQ-P2', result: 'CLOSED', ts: '2026-11-09T10:00:00Z' }),
      JSON.stringify({ event: 'outcome', job: 'RQ-P3', conclusion: 'MERGED', ts: '2026-11-09T10:00:00Z' }),
      // An explicit state still wins over a producer alias on the same row.
      JSON.stringify({ event: 'outcome', job: 'RQ-P4', state: 'CLOSED', phase: 'MERGED', ts: '2026-11-09T10:00:00Z' }),
    ].join('\n'), NOW, DAY);
    expect(rows.map((r) => [r.job, r.empty, r.merged])).toEqual([
      ['RQ-P1', false, true],
      ['RQ-P2', null, false],
      ['RQ-P3', false, true],
      ['RQ-P4', null, false],
    ]);
  });

  it('counts pre-launch skip verdicts as empty and honours the applied guard', () => {
    const rows = parseJobOutcomeRows([
      JSON.stringify({ ts: '2026-11-09T10:00:00Z', job: 'RQ-S1', event: 'skipped_empty', reason: 'already-merged' }),
      JSON.stringify({ ts: '2026-11-09T10:05:00Z', job: 'RQ-S2', event: 'precheck_skip', code: 13 }),
      // applied:false is the skip gate's dry run: the job still launched
      JSON.stringify({ ts: '2026-11-09T10:10:00Z', job: 'RQ-S3', event: 'precheck_skip', applied: false }),
      // batch member verdicts: skipped produced no work, done is unmeasured
      JSON.stringify({ ts: '2026-11-09T10:15:00Z', job: 'RQ-S4', event: 'task_outcome', outcome: 'skipped' }),
      JSON.stringify({ ts: '2026-11-09T10:20:00Z', job: 'RQ-S5', event: 'task_outcome', outcome: 'done' }),
      // a duplicate skip is a different verdict, not an empty finish
      JSON.stringify({ ts: '2026-11-09T10:25:00Z', job: 'RQ-S6', event: 'dupcheck_skip', reason: 'duplicate' }),
    ].join('\n'), NOW, DAY);
    expect(rows.map((r) => [r.job, r.empty, r.merged])).toEqual([
      ['RQ-S1', true, false],
      ['RQ-S2', true, false],
      ['RQ-S3', null, false],
      ['RQ-S4', true, false],
      ['RQ-S5', null, false],
      ['RQ-S6', null, false],
    ]);
  });
});

describe('collapseJobOutcomes', () => {
  it('keeps the newest row per job while preserving known verdicts', () => {
    const t1 = Date.parse('2026-11-09T10:00:00Z');
    const t2 = Date.parse('2026-11-09T11:00:00Z');
    const map = collapseJobOutcomes([
      { job: 'A', at: t1, empty: true, merged: false },
      { job: 'A', at: t2, empty: null, merged: false },   // newer row did not measure emptiness
      { job: 'B', at: t2, empty: false, merged: true },
      { job: 'B', at: t1, empty: true, merged: false },   // an older flag must not un-merge
      { job: 'C', at: t2, empty: null, merged: false },
      { job: 'C', at: t1, empty: true, merged: false },   // older measurement fills the gap
    ]);
    expect(map.get('A')).toMatchObject({ at: t2, empty: true, merged: false });
    expect(map.get('B')).toMatchObject({ at: t2, empty: false, merged: true });
    expect(map.get('C')).toMatchObject({ at: t2, empty: true, merged: false });
    expect(map.has('D')).toBe(false);
  });
});
