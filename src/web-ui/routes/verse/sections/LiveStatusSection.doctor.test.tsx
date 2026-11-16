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

const wire = (doctor: () => Promise<unknown>) => get.mockImplementation(async (path: string) => {
  if (path === '/api/verse/fleet/doctor') return doctor();
  if (path === '/api/verse/fleet/merge-pace') return { known: true, rows: [] };
  if (path === '/api/verse/fleet/landed-closes') return { known: true, rows: [], closed: 0, skipped: 0, failed: 0 };
  return {};
});
vi.mock('../../../../core/fleet/live-status.js', () => ({
  projectLiveStatus: () => ({ state: 'idle', reason: 'ok', generatedAt: '2026-11-02T00:00:00Z',
    running: [{ id: 'r1', repo: 'example/one', title: 'Job', phase: 'build' }], merged: [], blocked: [], spent: [] }),
}));

it('renders red checks before warn and ok checks with red styling', async () => {
  wire(async () => ({ v: 1, level: 'red', checks: [
    { name: 'worktrees', level: 'ok', reason: 'fresh' },
    { name: 'waste', level: 'warn', reason: 'empty jobs' },
    { name: 'heartbeat', level: 'red', reason: 'stale' },
  ] }));
  render(<LiveStatusSection />);
  const heading = await screen.findByRole('heading', { name: 'Fleet health' });
  const rows = heading.nextElementSibling!.querySelectorAll('li');
  expect(Array.from(rows, row => row.textContent)).toEqual([
    'red heartbeat: stale', 'warn waste: empty jobs', 'ok worktrees: fresh',
  ]);
  expect(rows[0]).toHaveStyle({ color: '#b3261e' });
});
it('shows All checks ok instead of a list when the report is ok', async () => {
  wire(async () => ({ v: 1, level: 'ok', checks: [{ name: 'leader', level: 'ok', reason: 'fresh' }] }));
  render(<LiveStatusSection />);
  expect(await screen.findByText('All checks ok')).toBeTruthy();
  expect(screen.queryByText('ok leader: fresh')).toBeNull();
});
it('shows Unknown under Fleet health when only the doctor fetch rejects', async () => {
  wire(async () => { throw new Error('unavailable'); });
  render(<LiveStatusSection />);
  await waitFor(() => expect(screen.getByText('example/one: Job · build')).toBeTruthy());
  const heading = screen.getByRole('heading', { name: 'Fleet health' });
  expect(heading.nextElementSibling?.textContent).toBe('Unknown');
  expect(screen.getByRole('heading', { name: 'Merge pace (6h)' })).toBeTruthy();
});
