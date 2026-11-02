import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { RunsLanesCard } from './RunsLanesCard.js';
import { FleetSection } from '../sections/FleetSection.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';

const lane = { lane: 'codex-personal', running: 24, target: 24, queued: 2, held: false, heldReason: null, tokensLastHour: 12000, merged24h: 3, mergeRate24h: 0.125 };
const data = { v: 1, generatedAt: '2026-10-31T12:00:40Z', lastTick: '2026-10-31T12:00:00Z', paused: false, switches: [], sources: { runsDir: 'healthy' }, lanes: [lane, { ...lane, lane: 'devin', running: 10, target: 10, held: true, heldReason: 'quota', tokensLastHour: null, merged24h: null }] };
function stub(value: unknown = data, status = 200) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL) => Response.json(value, { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const card = (visible = true) => <SectionVisibilityProvider visible={visible}><RunsLanesCard /></SectionVisibilityProvider>;
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('renders real rows, raw lane titles, queued and held notes and unknown metrics', async () => {
  stub(); render(card());
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  expect(screen.getByTitle('codex-personal')).toHaveTextContent('CODE');
  for (const text of ['24 / 24', '10 / 10', '12000', 'queued 2 · drains in ~13 min', 'held: quota']) expect(within(table).getByText(text)).toBeInTheDocument();
  expect(within(screen.getByTitle('codex-personal').closest('tr')!).getByTitle('queued 2 · drains in ~13 min')).toHaveTextContent('2');
  expect(within(screen.getByTitle('devin').closest('tr')!).getByTitle('held: quota')).toHaveTextContent('2');
  expect(within(screen.getByTitle('devin').closest('tr')!).getAllByText('—')).toHaveLength(2);
});
it('shows a stale tick tone', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T12:30:00Z'));
  stub(); render(card()); await act(async () => {});
  expect(screen.getByText('tick 30 min ago · stale')).toHaveAttribute('data-level', 'stale');
});
it('reports empty and degraded source states', async () => {
  stub({ ...data, lanes: [], sources: { runsDir: 'missing' } }); render(card());
  expect(await screen.findByText('No lanes reported on this Mac.')).toBeInTheDocument();
  expect(screen.getByText('runs directory missing')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
it('keeps lane evidence visible when the runs directory is degraded', async () => {
  stub({ ...data, sources: { runsDir: 'degraded' } }); render(card());
  expect(await screen.findByRole('table')).toHaveTextContent('24 / 24');
  expect(screen.getByText('runs directory degraded')).toBeInTheDocument();
});
it('polls every five seconds only while visible', async () => {
  vi.useFakeTimers(); const fetcher = stub(); const view = render(card()); await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(5_000)); expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(card(false)); await act(() => vi.advanceTimersByTimeAsync(10_000)); expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(card()); await act(async () => {}); expect(fetcher).toHaveBeenCalledTimes(3);
});
it('reports malformed responses as unavailable', async () => {
  stub({ ...data, lanes: [{ ...lane, running: '24' }] }); render(card());
  expect(await screen.findByText('Lane refresh unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
it('memoizes a missing endpoint across polling and remounts', async () => {
  vi.useFakeTimers(); const fetcher = stub({}, 404); const view = render(card()); await act(async () => {});
  expect(screen.getByText('The runs API is not in this build yet.')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(10_000)); view.unmount(); evictAll(); render(card()); await act(async () => {});
  expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/verse/fleet/runs')).toHaveLength(1);
});
it('mounts directly after Workers in Fleet', () => {
  stubSurfaceFetch({ kind: 'live' }); render(<FleetSection />);
  expect(screen.getByRole('region', { name: 'Lanes on this Mac' }).previousElementSibling).toBe(screen.getByRole('region', { name: 'Working on this Mac' }));
});
