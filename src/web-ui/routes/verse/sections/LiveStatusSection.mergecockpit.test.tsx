import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveStatusSection } from './LiveStatusSection.js';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../../data/client.js', () => ({ apiGet: get }));
vi.mock('../../../data/hooks.js', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useQuery: (q: { fetch: (s: AbortSignal) => Promise<unknown> }) => {
      const [data, setData] = useState<unknown>(undefined);
      useEffect(() => { void q.fetch(new AbortController().signal).then(setData); }, [q]);
      return { status: data ? 'success' : 'loading', data };
    },
    useRefetch: () => vi.fn(),
  };
});
afterEach(() => get.mockReset());

const live = { generatedAt: '2026-11-02T00:00:00Z' };
const wire = (cockpit: () => Promise<unknown>) => get.mockImplementation(async (path: string) => {
  if (path === '/api/verse/fleet/live') return live;
  if (path === '/api/resource') return {};
  if (path === '/api/verse/fleet/merge-pace') return { schema: 'fleet.merge-pace.v1', known: true, window_hours: 6, rows: [] };
  if (path === '/api/verse/fleet/landed-closes') return { v: 1, known: true, closed: 0, skipped: 0, failed: 0, rows: [] };
  if (path === '/api/verse/fleet/slow-prs') return { known: true, repos: [] };
  return cockpit();
});
vi.mock('../../../../core/fleet/live-status.js', () => ({
  projectLiveStatus: () => ({ state: 'idle', reason: 'ok', generatedAt: '2026-11-02T00:00:00Z',
    running: [{ id: 'r1', repo: 'example/one', title: 'Job', phase: 'build' }], merged: [], blocked: [], spent: [] }),
}));

it('renders merge cockpit totals and per-repo coverage', async () => {
  wire(async () => ({ schema: 'fleet.merge-cockpit.v1', v: 1, generatedAt: '2026-11-02T00:00:00Z', hours: 24, known: true,
    sources: { ready: 'healthy', claimed: 'healthy', queuegenState: 'healthy', jobs: 'healthy', landedCloses: 'missing', mergeEvents: 'missing' },
    jobsClipped: false,
    repos: [{ repo: 'example/one', conflictsOpen: 2, conflictsTriaged: 3, conflictsClosed: 1,
      triageToCloseS: { count: 1, medianS: 1800, p90S: 1800, maxS: 1800 }, conflictsUntracked: 0,
      coverage: { current: 1, staleHead: 1, worked: 0, uncovered: 0 },
      rebase: { ready: 1, running: 0, parked: 1, spins: 2, runs: 0, repeatPrs: 0 },
      merges: { count: 4, perHour: 4 / 24, medianTtmS: 900 } }],
    totals: { conflictsOpen: 2, conflictsTriaged: 3, conflictsClosed: 1,
      triageToCloseS: { count: 1, medianS: 1800, p90S: 1800, maxS: 1800 },
      rebase: { ready: 1, running: 0, parked: 1, spins: 2, runs: 0, repeatPrs: 0 },
      merges: { count: 4, perHour: 4 / 24, medianTtmS: 900 } } }));
  render(<LiveStatusSection />);
  expect(await screen.findByRole('heading', { name: 'Merge cockpit (24h)' })).toBeTruthy();
  expect(screen.getByText('2 conflicting open · rebase 1 ready/0 running/1 parked · 4 merged')).toBeTruthy();
  expect(screen.getByText('example/one: 2 open · 1 current/1 stale/0 worked/0 uncovered · triage→close 30 min · 4 merges')).toBeTruthy();
});

it('shows Unknown when the merge-cockpit fetch fails', async () => {
  wire(async () => { throw new Error('down'); });
  render(<LiveStatusSection />);
  await waitFor(() => expect(screen.getByText('example/one: Job · build')).toBeTruthy());
  expect(screen.getByRole('heading', { name: 'Merge cockpit (24h)' })).toBeTruthy();
  expect(screen.getByText('Unknown')).toBeTruthy();
});
