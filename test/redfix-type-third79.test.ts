import { describe, expect, it } from 'vitest';
import { mergeGraph } from '../src/core/fleet/merge-graph.js';

const now = Date.parse('2026-11-10T06:30:00Z');
const rows = [
  { event: 'launch', job: 'x', lane: 'work', ts: '2026-11-09T20:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'x', ts: '2026-11-09T23:15:00Z', ttm_s: 300 },
  { event: 'outcome', state: 'MERGED', job: 'y', lane: 'fast', ts: '2026-11-09T23:45:00Z', ttm_s: 30 },
  { event: 'outcome', state: 'FAILED', job: 'z', lane: 'fast', ts: '2026-11-09T23:50:00Z' },
];

describe('merge graph (redfix-third79)', () => {
  it('attributes a lane-less merge to its launch lane and reports the hourly bucket', () => {
    const report = mergeGraph(rows.map((row) => JSON.stringify(row)).join('\n'), now);
    expect(report).toMatchObject({ schema: 'metrics.merges.v1', known: true, windowHours: 24 });
    const work = report.lanes!.find((lane) => lane.lane === 'work')!;
    const fast = report.lanes!.find((lane) => lane.lane === 'fast')!;
    const hour23 = work.buckets.find((bucket) => bucket.start === '2026-11-09T23:00:00.000Z')!;
    expect(hour23).toMatchObject({ merges: 1, medianSeconds: 300 });
    expect(fast.buckets.find((bucket) => bucket.start === '2026-11-09T23:00:00.000Z')).toMatchObject({ merges: 1, medianSeconds: 30 });
  });
  it('ignores malformed lines, non-merge outcomes and future rows', () => {
    const raw = ['not json', '{"event":"outcome"}', JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'fut', lane: 'work', ts: '2099-01-01T00:00:00Z' }), ...rows.map((row) => JSON.stringify(row))].join('\n');
    const report = mergeGraph(raw, now);
    expect(report.lanes!.reduce((sum, lane) => sum + lane.buckets.reduce((s, bucket) => s + bucket.merges, 0), 0)).toBe(2);
  });
});
