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
const wire = (pace: () => Promise<unknown>) => get.mockImplementation(async (path: string) => {
  if (path === '/api/verse/fleet/live') return live;
  if (path === '/api/resource') return {};
  if (path === '/api/verse/fleet/landed-closes') return { v: 1, known: true, closed: 0, skipped: 0, failed: 0, rows: [] };
  if (path === '/api/verse/fleet/slow-prs') return { known: true, repos: [] };
  return pace();
});
vi.mock('../../../../core/fleet/live-status.js', () => ({
  projectLiveStatus: () => ({ state: 'idle', reason: 'ok', generatedAt: '2026-11-02T00:00:00Z',
    running: [{ id: 'r1', repo: 'example/one', title: 'Job', phase: 'build' }], merged: [], blocked: [], spent: [] }),
}));

it('renders merge pace rows', async () => {
  wire(async () => ({ schema: 'fleet.merge-pace.v1', known: true, window_hours: 6, rows: [
    { repo: 'example/one', merges: 2, merges_per_hour: 1 / 3, median_ttm_s: 360 },
    { repo: 'total', merges: 2, merges_per_hour: 1 / 3, median_ttm_s: null }] }));
  render(<LiveStatusSection />);
  expect(await screen.findByRole('heading', { name: 'Merge pace (6h)' })).toBeTruthy();
  expect(screen.getByText('example/one: 2 merges · 0.3/h · median 6 min')).toBeTruthy();
  expect(screen.getByText('total: 2 merges · 0.3/h · median unknown')).toBeTruthy();
});

it('shows Unknown when only the merge-pace fetch fails', async () => {
  wire(async () => { throw new Error('down'); });
  render(<LiveStatusSection />);
  await waitFor(() => expect(screen.getByText('example/one: Job · build')).toBeTruthy());
  expect(screen.getByRole('heading', { name: 'Merged (24h)' })).toBeTruthy();
  expect(screen.getByText('Unknown')).toBeTruthy();
});
