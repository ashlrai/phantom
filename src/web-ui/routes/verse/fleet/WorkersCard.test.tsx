import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { WorkersCard } from './WorkersCard.js';
import { FleetSection } from '../sections/FleetSection.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';

const snapshot = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { workers: 'healthy' }, workers: [
  { job: 'job-one', repo: 'example/repo', lane: 'work', tier: 'mid', ageSeconds: 59 },
  { job: 'job-two', repo: 'example/repo', lane: 'frontier', tier: 'frontier', ageSeconds: null },
], publishesLastHour: [
  { job: 'job-one', lane: null, url: 'https://github.com/example/repo/pull/1', at: 'now' },
  { job: 'job-two', lane: null, url: 'http://example.com/unsafe', at: 'now' },
] };
const detail = { schema: 'fleet.job.v1', job: 'job-one', state: 'running', lane: 'work', tier: 'mid', model: 'example-model',
  launchedAt: '2026-10-31T12:00:00Z', baseSha: 'abc1234ffff', branch: 'example-branch', publish: { prUrl: 'https://github.com/example/repo/pull/1', autoMerge: false },
  notes: { hasNotes: true }, log: { source: 'live', tail: ['Scrubbed line one', 'Scrubbed line two'], truncated: true },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
function stub(status = 200, source = 'healthy') {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).startsWith('/api/fleet/job')
    ? Response.json(detail, { status }) : Response.json({ ...snapshot, sources: { workers: source } }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const card = (visible = true) => <SectionVisibilityProvider visible={visible}><WorkersCard /></SectionVisibilityProvider>;
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('renders workers and safe PR links, opens read-only facts and log tail', async () => {
  const fetcher = stub(); render(card());
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  expect(within(table).getAllByRole('link')).toHaveLength(1);
  expect(within(table).getByRole('link')).toHaveAttribute('href', snapshot.publishesLastHour[0]!.url);
  fireEvent.click(screen.getByRole('button', { name: 'Job job-one' }));
  const sheet = await screen.findByRole('dialog', { name: 'job-one' });
  await within(sheet).findByText('running');
  for (const text of ['example-model', 'abc1234', 'example-branch', 'Auto-merge off', 'Notes present: yes']) expect(within(sheet).getByText(text)).toBeInTheDocument();
  expect(within(sheet).getByText(/Scrubbed line one/)).toHaveTextContent('Scrubbed line two');
  expect(within(sheet).getByText('Log tail (live, 2 lines, truncated)')).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([url]) => url === '/api/fleet/job?id=job-one')).toBe(true);
});
it('polls only while visible and stops detail polling on close', async () => {
  vi.useFakeTimers(); const fetcher = stub(); const view = render(card());
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Job job-one' })); await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/fleet/job'))).toHaveLength(2);
  view.rerender(card(false)); await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(fetcher).toHaveBeenCalledTimes(4);
  view.rerender(card()); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  const count = fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/fleet/job')).length;
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/fleet/job'))).toHaveLength(count);
});
it('reports missing workers without a table', async () => {
  stub(200, 'missing'); render(card());
  await screen.findByText('Worker list unavailable'); expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByText('worker list missing')).toBeInTheDocument();
});
it('mounts directly after the inbox in Fleet', () => {
  stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/fleet/runs': { ...snapshot, inbox: [] } } }); render(<SectionVisibilityProvider visible><FleetSection /></SectionVisibilityProvider>);
  expect(screen.getByRole('region', { name: 'Working on this Mac' }).previousElementSibling).toBe(screen.getByRole('region', { name: 'Tell the leaders' }));
});
it('memoizes missing detail across rerenders, polls and reopening', async () => {
  vi.useFakeTimers(); const fetcher = stub(404); const view = render(card()); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Job job-two' })); await act(async () => {});
  expect(screen.getByText('Job detail is not in this build yet.')).toBeInTheDocument();
  view.rerender(card()); await act(() => vi.advanceTimersByTimeAsync(10_000));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Job job-two' })); await act(async () => {});
  expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/fleet/job'))).toHaveLength(1);
});
