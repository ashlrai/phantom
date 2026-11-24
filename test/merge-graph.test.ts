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
  it('reads the jobs-ledger dialect: reconciler and eventless merge rows count', () => {
    const text = [
      // Launch through the type/kind + jobId + pool + timestamp dialect.
      JSON.stringify({ type: 'launch', jobId: 'd', pool: 'mid', timestamp: '2026-11-08T10:00:00Z' }),
      // Reconciler row: copied publish event, outcome MERGED, prUrl, mergedAt.
      JSON.stringify({ event: 'publish', jobId: 'd', prUrl: 'https://github.com/o/r/pull/1', outcome: 'MERGED', ts: '2026-11-09T11:00:00Z', mergedAt: '2026-11-09T10:55:00Z', source: 'metrics-outcomes-reconciler' }),
      // Eventless-phase merge via kind + status + lane + at + ttmS.
      JSON.stringify({ kind: 'outcome', id: 'e', status: 'MERGED', lane: 'fast', at: '2026-11-09T11:20:00Z', ttmS: 45 }),
      // A merged event with no phase counts; alternate timestamp fields parse.
      JSON.stringify({ event: 'merged', job: 'f', url: 'https://github.com/o/r/pull/2', recordedAt: '2026-11-09T11:40:00Z' }),
      // A contradictory terminal state still beats the merged event name.
      JSON.stringify({ event: 'merged', job: 'g', state: 'CLOSED', ts: '2026-11-09T11:45:00Z' }),
    ].join('\n');
    const report = mergeGraph(text, now);
    const byLane = new Map(report.lanes!.map(lane => [lane.lane, lane]));
    expect(byLane.get('mid')!.buckets[21]).toMatchObject({ start: '2026-11-09T10:00:00.000Z', merges: 1, medianSeconds: null });
    expect(byLane.get('fast')!.buckets[22]).toMatchObject({ start: '2026-11-09T11:00:00.000Z', merges: 1, medianSeconds: 45 });
    expect(byLane.get('unknown')!.buckets[22]).toMatchObject({ merges: 1, medianSeconds: null });
    expect(report.lanes).toHaveLength(3);
  });
  it('distinguishes an unreadable ledger from an empty one', () => {
    expect(mergeGraph(null, now)).toMatchObject({ known: false, lanes: null });
    expect(mergeGraph('', now)).toMatchObject({ known: true, lanes: [] });
  });
});
