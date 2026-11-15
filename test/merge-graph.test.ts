import { describe, expect, it } from 'vitest';
import { mergeGraph } from '../src/core/fleet/merge-graph.js';

const now = Date.parse('2026-11-09T12:30:00Z');
const rows = [
  { event: 'launch', job: 'a', lane: 'work', ts: '2026-11-08T09:00:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'a', ts: '2026-11-09T11:05:00Z', ttm_s: 60 },
  { event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:30:00Z', ttm_s: 180 },
  { event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:30:00Z', ttm_s: 180 },
  { event: 'outcome', state: 'MERGED', job: 'c', lane: 'fast', ts: '2026-11-09T12:10:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'old', lane: 'work', ts: '2026-11-08T12:59:00Z' },
];
describe('merge graph', () => {
  it('buckets unique merges by lane and computes medians from known times', () => {
    const report = mergeGraph(rows.map(row => JSON.stringify(row)).join('\n'), now);
    const work = report.lanes!.find(lane => lane.lane === 'work')!;
    expect(work.buckets).toHaveLength(24);
    expect(work.buckets[22]).toMatchObject({ start: '2026-11-09T11:00:00.000Z', merges: 2, medianSeconds: 120 });
    expect(work.buckets[0]).toMatchObject({ merges: 0, medianSeconds: null });
    expect(report.lanes![0]!.buckets[23]).toMatchObject({ merges: 1, medianSeconds: null });
  });
  it('distinguishes an unreadable ledger from an empty one', () => {
    expect(mergeGraph(null, now)).toMatchObject({ known: false, lanes: null });
    expect(mergeGraph('', now)).toMatchObject({ known: true, lanes: [] });
  });
});
