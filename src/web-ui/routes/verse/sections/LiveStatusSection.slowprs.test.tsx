import { render, screen } from '@testing-library/react';
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
vi.mock('../../../../core/fleet/live-status.js', () => ({
  projectLiveStatus: () => ({ state: 'idle', reason: 'ok', generatedAt: '2026-11-02T00:00:00Z',
    running: [{ id: 'r1', repo: 'example/one', title: 'Job', phase: 'build' }], merged: [], blocked: [], spent: [] }),
}));
afterEach(() => get.mockReset());

const wire = (slowPrs: () => Promise<unknown>) => get.mockImplementation(async (path: string) => {
  if (path === '/api/verse/fleet/live') return { generatedAt: '2026-11-02T00:00:00Z' };
  if (path === '/api/resource') return {};
  if (path === '/api/verse/fleet/merge-pace') return { schema: 'fleet.merge-pace.v1', known: true, window_hours: 6, rows: [] };
  if (path === '/api/verse/fleet/landed-closes') return { v: 1, known: true, closed: 0, skipped: 0, failed: 0, rows: [] };
  return slowPrs();
});

it('renders repo lines and #N links opened on github.com', async () => {
  wire(async () => ({ known: true, repos: [
    { repo: 'example/demo', count: 2, urls: ['https://github.com/example/demo/pull/12', 'https://github.com/example/demo/pull/34'] }] }));
  render(<LiveStatusSection />);
  expect(await screen.findByRole('heading', { name: 'Slow PRs' })).toBeTruthy();
  expect(screen.getByText(/example\/demo: 2 open over 30 min/)).toBeTruthy();
  const link = screen.getByRole('link', { name: '#12' });
  expect(link.getAttribute('href')).toBe('https://github.com/example/demo/pull/12');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.getByRole('link', { name: '#34' })).toBeTruthy();
});

it('renders no link for a non-github URL', async () => {
  wire(async () => ({ known: true, repos: [{ repo: 'example/demo', count: 1, urls: ['https://evil.example/pull/5'] }] }));
  render(<LiveStatusSection />);
  expect(await screen.findByText(/example\/demo: 1 open over 30 min/)).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});

it('shows Unknown when the report is unknown or the fetch fails', async () => {
  wire(async () => ({ known: false, repos: [] }));
  const first = render(<LiveStatusSection />);
  expect(await screen.findByText('Unknown')).toBeTruthy();
  first.unmount();
  wire(async () => { throw new Error('down'); });
  render(<LiveStatusSection />);
  expect(await screen.findByText('Unknown')).toBeTruthy();
});

it('shows None open over 30 min. for an empty report', async () => {
  wire(async () => ({ known: true, repos: [] }));
  render(<LiveStatusSection />);
  expect(await screen.findByText('None open over 30 min.')).toBeTruthy();
});

it('caps links at 10 per repo with +K more', async () => {
  wire(async () => ({ known: true, repos: [{ repo: 'example/demo', count: 12,
    urls: Array.from({ length: 12 }, (_, i) => `https://github.com/example/demo/pull/${i + 1}`) }] }));
  render(<LiveStatusSection />);
  await screen.findByRole('heading', { name: 'Slow PRs' });
  expect(screen.getAllByRole('link')).toHaveLength(10);
  expect(screen.getByText(/\+2 more/)).toBeTruthy();
});
