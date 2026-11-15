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
