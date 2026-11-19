import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MetricsPane } from './MetricsPane.js';

const hours = (known: boolean) => Array.from({ length: 24 }, (_, i) => ({
  start: new Date(Date.UTC(2026, 10, 16, 12 + i)).toISOString(), end: new Date(Date.UTC(2026, 10, 16, 13 + i)).toISOString(),
  merged: known ? i === 23 ? 3 : i === 20 ? 1 : 0 : null, byRepo: !known ? {} : i === 23 ? { phantom: 2, locus: 1 } : i === 20 ? { phantom: 1 } : {},
  launches: known ? 2 : null, mergesPerLaunch: known ? i === 23 ? 1.5 : i === 20 ? 0.5 : 0 : null }));
const panel = (known = true) => ({ schema: 'fleet.metrics-panel.v1', observedAt: null,
  series: { schema: 'fleet.metrics-series.v1', known, observedAt: '2026-11-17T12:00:00Z', since: '2026-11-16T12:00:00Z',
    mergesLastHour: known ? 3 : null, mergesLast24h: known ? 4 : null, malformedLines: 0, hours: hours(known) },
  generatorYield: { known: true, malformedLines: 0, generators: [] }, lanes: [],
  glance: { hours: 24, sources: { jobs: 'ok', status: 'ok' }, merged_per_hour: { last_1h: 3, last_6h: 0.67, last_24h: 0.17, window: 0.17 }, median_publish_to_merge_s: 90,
    empty_rate: 0.2, pools_at_risk: 1, tiers: [],
    pools: [{ pool: 'claude-max', used_pct: 40, hours_to_reset: 5, projected_unused_pct: 30, waste_risk: 'high', at_risk: true, reason: null },
      { pool: 'devin', used_pct: null, hours_to_reset: null, projected_unused_pct: null, waste_risk: null, at_risk: null, reason: 'reading missing' }],
    lanes: [{ name: 'claude', jobs: 10, merged: 6, empty_rate: 0.2, merge_rate: 0.6, empty_high: false },
      { name: 'devin', jobs: 4, merged: null, empty_rate: null, merge_rate: null, empty_high: null }] } });
const state = vi.hoisted(() => ({ read: { status: 'success', data: undefined as unknown }, refetch: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.read, useRefetch: () => state.refetch }));
const open = () => render(<MetricsPane {...({ visible: true } as Parameters<typeof MetricsPane>[0])} />);
beforeEach(() => { state.read = { status: 'success', data: panel() }; state.refetch.mockClear(); });
afterEach(cleanup);

it('leads with the merged sentence, the busiest hour and a sparkline of the measured hours', () => {
  open();
  expect(screen.getByText('Merged PRs: 3 in the last hour · 4 in the last 24 hours.')).toBeTruthy();
  expect(screen.getByText(/^Busiest hour started .+ with 3 merged\. Updated /)).toBeTruthy();
  expect(screen.getByRole('img', { name: /^PRs merged in each of the last 24 hours/ }).getAttribute('aria-label')).toContain('from 0 to 3');
});

it('ranks the repos the merges landed in, each with its count and share', () => {
  open();
  const rows = within(screen.getByRole('list', { name: 'Merged PRs by repo, last 24 hours' })).getAllByRole('listitem');
  expect(rows.map(row => row.textContent)).toEqual(['phantom3 merged · 75%', 'locus1 merged · 25%']);
});

it('marks each lane and pool with its provider and draws a lane outcome only where both shares are measured', () => {
  const { container } = open();
  const claude = screen.getByRole('row', { name: /^claude/ });
  expect(claude.querySelector('svg[data-provider]')?.getAttribute('data-provider')).not.toBe('unknown');
  const bars = [...container.querySelectorAll('tbody td > span[aria-hidden="true"]')];
  expect(bars).toHaveLength(2);
  expect([...bars[0]!.children].map(part => (part as HTMLElement).style.width)).toEqual(['60%', '20%']);
  expect(bars[0]!.hasAttribute('data-unknown')).toBe(false);
  // The second lane has no measured shares: a hatched track with no segment, and the cell still says unknown.
  expect(bars[1]!.hasAttribute('data-unknown')).toBe(true);
  expect(bars[1]!.children).toHaveLength(0);
  expect(within(screen.getByRole('row', { name: /^devin/ })).getAllByRole('cell')[3]!.textContent).toBe('unknown');
  const pools = within(screen.getByRole('list', { name: 'Spend-down by pool' })).getAllByRole('listitem');
  expect(pools[0]!.querySelector('svg[data-provider]')).toBeTruthy();
  // An unread pool gets no meter and a hatched bar, never an empty one that reads as unused.
  expect(within(pools[1]!).queryByRole('meter')).toBeNull();
  expect(pools[1]!.querySelector('[data-unknown]')).toBeTruthy();
  expect(pools[1]!.textContent).toContain('unknown: reading missing');
});

it('draws no sparkline, busiest hour or repo list when the history is unreadable', () => {
  state.read = { status: 'success', data: panel(false) };
  open();
  expect(screen.getByText('Merged PRs: unknown in the last hour · unknown in the last 24 hours.')).toBeTruthy();
  expect(screen.queryByRole('img', { name: /^PRs merged in each of the last 24 hours/ })).toBeNull();
  expect(screen.queryByText(/Busiest hour/)).toBeNull();
  expect(screen.queryByRole('list', { name: 'Merged PRs by repo, last 24 hours' })).toBeNull();
});

it('shows tile placeholders and no number while the first read is out', () => {
  state.read = { status: 'loading', data: undefined };
  const { container } = open();
  expect(screen.getByRole('status').textContent).toBe('Reading metrics…');
  expect(container.querySelectorAll('[data-stat-tile-skeleton]')).toHaveLength(4);
  expect(container.textContent).not.toMatch(/\d|unknown/);
});

it('says the report is unknown when the first read fails and reads again on Try again', () => {
  state.read = { status: 'error', data: undefined };
  const { container } = open();
  expect(within(screen.getByRole('alert')).getByText('Metrics are unknown.')).toBeTruthy();
  expect(container.textContent).not.toMatch(/\d/);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(state.refetch).toHaveBeenCalledTimes(1);
});

it('keeps the last board and says so when a refresh fails', () => {
  state.read = { status: 'error', data: panel() };
  open();
  expect(screen.getByText('Could not refresh. Showing the last reading.')).toBeTruthy();
  expect(screen.getByText('Merged PRs: 3 in the last hour · 4 in the last 24 hours.')).toBeTruthy();
});
