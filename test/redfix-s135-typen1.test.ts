import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MergeGraphReport } from '../src/core/fleet/merge-graph.js';
import { mergeGraph } from '../src/core/fleet/merge-graph.js';

// The QueryDef contract this recut satisfies expects fetch to tolerate an
// omitted AbortSignal; mocking hooks keeps the component on the report path
// without a DOM (data/hooks.js pulls in theme-store, which needs document).
vi.mock('../src/web-ui/data/hooks.js', () => ({
  useQuery: () => ({
    status: 'ready',
    data: {
      schema: 'metrics.merges.v1',
      known: true,
      windowHours: 24,
      lanes: [{ lane: 'work', buckets: [{ start: '2026-11-09T11:00:00.000Z', merges: 3, medianSeconds: 120 }] }],
    } satisfies MergeGraphReport,
  }),
}));

describe('merge graph recut (#4387)', () => {
  it('buckets merges into hourly lanes and reports medians', () => {
    const report = mergeGraph([
      JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'a', lane: 'work', ts: '2026-11-09T11:20:00Z', ttm_s: 120 }),
      JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'b', lane: 'work', ts: '2026-11-09T11:40:00Z', ttm_s: 60 }),
    ].join('\n'), Date.parse('2026-11-09T12:00:00Z'));
    expect(report.known).toBe(true);
    const work = report.lanes!.find(lane => lane.lane === 'work')!;
    expect(work.buckets[22]).toMatchObject({ merges: 2, medianSeconds: 90 });
  });

  it('renders the fixed MergeGraph component to markup', async () => {
    const { MergeGraph } = await import('../src/web-ui/routes/verse/growth/MergeGraph.js');
    const html = renderToStaticMarkup(createElement(MergeGraph));
    expect(html).toContain('Merges by lane');
    expect(html).toContain('>3<');
    expect(html).toContain('>2.0<');
  });
});
