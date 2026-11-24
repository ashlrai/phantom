import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MetricsPane } from './MetricsPane.js';
const state = vi.hoisted(() => ({ known: true, empty: false }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: () => ({ status: 'success', data: { observedAt: null,
    series: { schema: 'fleet.metrics-series.v1', known: state.known, observedAt: '2026-11-17T12:00:00Z', since: '2026-11-16T12:00:00Z',
      mergesLastHour: state.known ? state.empty ? 0 : 2 : null, mergesLast24h: state.known ? state.empty ? 0 : 3 : null, malformedLines: 0,
      hours: Array.from({ length: 24 }, (_, i) => ({ start: new Date(Date.UTC(2026, 10, 16, 12 + i)).toISOString(), end: new Date(Date.UTC(2026, 10, 16, 13 + i)).toISOString(),
        merged: state.known ? state.empty ? 0 : i === 23 ? 2 : i === 22 ? 1 : 0 : null,
        byRepo: state.empty || !state.known ? {} : i === 23 ? { phantom: 2 } : i === 22 ? { locus: 1 } : {},
        launches: state.known ? state.empty ? 0 : i >= 22 ? 4 : 0 : null,
        mergesPerLaunch: state.known && !state.empty && i >= 22 ? i === 23 ? 0.5 : 0.25 : null })) },
    generatorYield: { known: true, malformedLines: 1, generators: [{ generator: 'filler', jobs: 2, prs: 1, merged: 1, emptyRate: null, medianDiffLines: 12, tokensPerMergedPr: null }] }, lanes: [{ lane: 'work', mergesPerHour: 0.5, medianOpenToMergeSeconds: 120, emptyRate: 0.25, running: 2, target: 4 }],
    glance: { hours: 24, sources: { jobs: 'ok', status: 'ok' }, merged_per_hour: { last_1h: 2, last_6h: 0.5, last_24h: 0.13, window: 0.13 }, median_publish_to_merge_s: 120,
      empty_rate: 0.25, pools_at_risk: null, tiers: [], pools: [], lanes: [{ name: 'work', jobs: 8, merged: 6, empty_rate: 0.25, merge_rate: 0.75, empty_high: false }] } } }),
  useRefetch: () => vi.fn(),
}));
beforeEach(() => { state.known = true; state.empty = false; });
it('shows the rollup, measured totals and both real hourly charts', () => {
  render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
  expect(screen.getAllByText('0.50').length).toBeGreaterThan(0);
  // The lane table is the `phm metrics` rollup joined to lane capacity.
  expect(within(screen.getByRole('row', { name: /^work/ })).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['8', '6', '25%', '75%', '2 / 4']);
  expect(screen.getByText('1 h 2 · 6 h 0.5 · 24 h 0.13')).toBeTruthy();
  expect(screen.getByText('Merged PRs: 2 in the last hour · 3 in the last 24 hours.')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Merged PRs per hour by repo' })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Merged PRs per launch by hour' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'phantom', hidden: true })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'locus', hidden: true })).toBeTruthy();
  expect(screen.getByText(/Human actions are not recorded/)).toBeTruthy();
  // The shared mock answers the releases read with the metrics payload, which is not a releases report.
  expect(screen.getByText('Releases: unknown')).toBeTruthy();
});

it('shows generator yield and missing measurements', () => {
  render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
  expect(screen.getByText('filler')).toBeTruthy();
  expect(screen.getByText('Malformed lines skipped: 1')).toBeTruthy();
  expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
});

it('shows the Job yield card as unknown when the server sends no report', () => {
  render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
  expect(screen.getByRole('heading', { name: 'Job yield' })).toBeTruthy();
  expect(screen.getByText('Job yield: unknown')).toBeTruthy();
});

it('keeps unreadable history unknown and does not draw invented measurements', () => {
  state.known = false;
  render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
  expect(screen.getByText('Merged PRs: unknown in the last hour · unknown in the last 24 hours.')).toBeTruthy();
  expect(screen.getByText('Merge history: unknown (job metrics file unreadable).')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Merged PRs per hour by repo' })).toBeNull();
});

it('shows readable empty history as zero with gaps for hours without launches', () => {
  state.empty = true;
  render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
  expect(screen.getByText('Merged PRs: 0 in the last hour · 0 in the last 24 hours.')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Merged PRs per hour by repo' })).toBeTruthy();
  expect(screen.getAllByText('No launches')).toHaveLength(24);
  expect(screen.queryByText('Merge history: unknown (job metrics file unreadable).')).toBeNull();
});
