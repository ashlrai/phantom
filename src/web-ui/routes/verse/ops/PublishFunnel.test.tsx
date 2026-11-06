import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { OpsSection } from '../sections/OpsSection.js';
import { PublishFunnel } from './PublishFunnel.js';

const fixture = {
  v: 1, generatedAt: '2026-10-31T10:00:00Z', lastTick: null, paused: false, claudeLane: null,
  workers: [{ job: 'RQ-RUN', ageSeconds: 180 }], events: [],
  publishesLastHour: [
    { job: 'RQ-MERGED', lane: 'codex', url: 'https://github.com/example/repo/pull/1', at: '2026-10-31T09:30:00Z' },
    { job: 'RQ-WAIT', lane: null, url: 'https://example.com/pull/2', at: '2026-10-31T09:40:00Z' },
  ],
  mergesLastHour: { count: 1, items: [{ repo: 'example/repo', number: 1, title: 'bridge: RQ-MERGED' }] },
  sources: { merges: 'healthy' },
};
const wrap = (visible = true) => <SectionVisibilityProvider visible={visible}><PublishFunnel /></SectionVisibilityProvider>;
beforeEach(() => { evictAll(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('renders joined rows and links only to GitHub', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
  render(wrap());
  const merged = (await screen.findByText('RQ-MERGED')).closest('tr')!;
  const waiting = screen.getByText('RQ-WAIT').closest('tr')!;
  expect(within(merged).getByText('merged')).toBeInTheDocument();
  expect(within(waiting).getByText('waiting')).toBeInTheDocument();
  expect(within(merged).getByRole('link')).toHaveAttribute('href', 'https://github.com/example/repo/pull/1');
  expect(within(merged).getByRole('link')).toHaveAttribute('rel', 'noreferrer');
  expect(within(waiting).queryByRole('link')).toBeNull();
  expect(screen.getByRole('img', { name: '1 of 2 published merged' })).toBeInTheDocument();
});

it('stops after a 404 until the section is reopened', async () => {
  const fetcher = vi.fn(async () => Response.json({}, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  vi.useFakeTimers();
  const { rerender } = render(wrap());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('Publish funnel is not in this build yet.')).toBeInTheDocument();
  rerender(wrap());
  await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  rerender(wrap(false)); rerender(wrap(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('polls every 15 seconds only while visible', async () => {
  const fetcher = vi.fn(async () => Response.json(fixture));
  vi.stubGlobal('fetch', fetcher);
  vi.useFakeTimers();
  const { rerender } = render(wrap());
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rerender(wrap(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rerender(wrap(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('mounts pulse, funnel and the ops view together', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/verse/fleet/runs') return Response.json(fixture);
    if (String(input).includes('/api/verse/ops/board')) return Response.json({ v: 1, generatedAt: fixture.generatedAt, team: 'default', columns: { next: [], active: [], held: [], done: [], closed: [] }, counts: { next: 0, active: 0, held: 0, done: 0, closed: 0 }, sources: { fleet: 'healthy', handoff: 'healthy', companion: 'healthy' } });
    return Response.json({}, { status: 404 });
  }));
  render(<SectionVisibilityProvider visible><OpsSection /></SectionVisibilityProvider>);
  expect(await screen.findByText(/Last start 3 min ago/)).toBeInTheDocument();
  expect(await screen.findByText('Publish → merge, last hour')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Board' })).toBeInTheDocument());
});
