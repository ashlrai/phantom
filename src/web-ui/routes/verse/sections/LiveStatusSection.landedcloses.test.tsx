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
vi.mock('../../../../core/fleet/live-status.js', () => ({
  projectLiveStatus: () => ({ state: 'idle', reason: 'ok', generatedAt: '2026-11-02T00:00:00Z',
    running: [{ id: 'r1', repo: 'example/one', title: 'Job', phase: 'build' }], merged: [], blocked: [], spent: [] }),
}));
afterEach(() => get.mockReset());

const wire = (closes: () => Promise<unknown>) => get.mockImplementation(async (path: string) => {
  if (path === '/api/verse/fleet/live') return { generatedAt: '2026-11-02T00:00:00Z' };
  if (path === '/api/resource') return {};
  if (path === '/api/verse/fleet/merge-pace') return { schema: 'fleet.merge-pace.v1', known: true, window_hours: 6, rows: [] };
  return closes();
});

it('renders counts and a failed row with its reason', async () => {
  wire(async () => ({ v: 1, known: true, closed: 1, skipped: 0, failed: 1, rows: [
    { at: '2026-11-02T10:00:00.000Z', pr: 901, outcome: 'failed', reason: 'fake gh failure' },
    { at: '2026-11-02T09:00:00.000Z', pr: 900, outcome: 'closed' }] }));
  render(<LiveStatusSection />);
  expect(await screen.findByRole('heading', { name: 'Stale PRs cleared (24h)' })).toBeTruthy();
  expect(screen.getByText('1 closed · 0 skipped · 1 failed')).toBeTruthy();
  expect(screen.getByText(/^#901 · failed · .+ · fake gh failure$/)).toBeTruthy();
  expect(screen.getByText(/^#900 · closed · [^·]+$/)).toBeTruthy();
});

it('shows Unknown when the fetch rejects and keeps the rest of the page', async () => {
  wire(async () => { throw new Error('down'); });
  render(<LiveStatusSection />);
  await waitFor(() => expect(screen.getByText('example/one: Job · build')).toBeTruthy());
  expect(screen.getByRole('heading', { name: 'Stale PRs cleared (24h)' })).toBeTruthy();
  expect(screen.getByText('Unknown')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Merged (24h)' })).toBeTruthy();
});
