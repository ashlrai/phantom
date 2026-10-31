import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { mockWideViewport } from '../shell/viewport.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { CommandSection } from '../sections/CommandSection.js';
import { stubSurfaceFetch } from './fetch-stub.test-support.js';
import { RunsNowRow } from './RunsNowRow.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const fixture = { v: 1, generatedAt: new Date(now).toISOString(), workers: [{ job: 'a' }, { job: 'b' }], mergesLastHour: { count: 2 }, codexPersonal: { usedPct: 64, resetsAt: new Date(now + 10800000).toISOString(), asOf: null }, leaders: [{ label: 'a', ageSeconds: 240 }], sources: { workers: 'healthy', merges: 'healthy', codex: 'healthy' } };
const row = (visible = true) => <SectionVisibilityProvider visible={visible}><RunsNowRow now={now} /></SectionVisibilityProvider>;
beforeEach(() => { evictAll(); resetActivityForTest(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders the four current tiles', async () => {
  stubSurfaceFetch({ routes: { '/api/verse/fleet/runs': fixture } });
  render(row());
  const group = await screen.findByRole('group', { name: /Right now: 2 workers/ });
  for (const text of ['Workers running', 'Merged last hour', 'Personal Codex used', '64%', 'resets in 3 h', 'Leader passes', 'newest 4 min ago']) expect(within(group).getByText(text)).toBeInTheDocument();
  expect(group.querySelectorAll('[data-stat-tile]')).toHaveLength(4);
});

it('memoizes a 404 until the section reopens', async () => {
  const clear = vi.spyOn(globalThis, 'clearInterval');
  const { fetchMock } = stubSurfaceFetch({ routes: { '/api/verse/fleet/runs': null } });
  const view = render(row());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  expect(clear).toHaveBeenCalled();
  clear.mockRestore();
  view.rerender(row());
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  view.rerender(row(false));
  view.rerender(row(true));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it('hides the row when the optional route is unavailable', async () => {
  const { fetchMock } = stubSurfaceFetch({ routes: { '/api/verse/fleet/runs': () => new Response('{}', { status: 503 }) } });
  const view = render(row());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.container).toBeEmptyDOMElement());
});

it('mounts before the KPI row in Command', async () => {
  const viewport = mockWideViewport();
  try {
    stubSurfaceFetch({ routes: { '/api/verse/fleet/runs': fixture } });
    render(<SectionVisibilityProvider visible><CommandSection /></SectionVisibilityProvider>);
    const group = await screen.findByRole('group', { name: /Right now: 2 workers/ }, { timeout: 10_000 });
    const kpis = await screen.findByRole('group', { name: 'Key numbers' }, { timeout: 10_000 });
    expect(group.compareDocumentPosition(kpis) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } finally { viewport.restore(); }
}, 20_000);

it('polls only while visible and retains data during a refresh', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const clear = vi.spyOn(globalThis, 'clearInterval');
  const { fetchMock } = stubSurfaceFetch({ routes: { '/api/verse/fleet/runs': fixture } });
  const view = render(row());
  await screen.findByRole('group', { name: /Right now: 2 workers/ });
  const tick = intervals.mock.calls.find(call => call[1] === 10_000)?.[0];
  expect(typeof tick).toBe('function');
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  await act(async () => { (tick as () => void)(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('group', { name: /Right now: 2 workers/ })).toBeInTheDocument();
  view.rerender(row(false));
  expect(clear).toHaveBeenCalled();
  await act(async () => { finish(new Response(JSON.stringify(fixture), { status: 200 })); });
  intervals.mockRestore();
  clear.mockRestore();
});
