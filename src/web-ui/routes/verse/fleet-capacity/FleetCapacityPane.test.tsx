import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';

const now = Date.now();
const fixture = {
  v: 1, generatedAt: new Date(now).toISOString(), from: new Date(now - 24 * 60 * 60_000).toISOString(), to: new Date(now).toISOString(), sourceState: 'healthy', dropped: 0,
  samples: [2, 1, 0].map((minute) => ({ at: new Date(now - minute * 60_000).toISOString(), workers: 2, leaders: 1, paused: minute === 1, lanes: [
    { lane: 'codex', running: 1, target: 2, queued: 3, held: minute === 2 },
    { lane: 'alpha', running: 2, target: 2, queued: 0, held: false },
  ] })),
};
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows lane readings, bands, and worker history', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
  render(<FleetCapacityPane visible />);
  expect(await screen.findByText('24 h · 2 lanes · 3 samples · 0 launch gaps')).toBeInTheDocument();
  expect(screen.getByLabelText('codex: ran at 50% of target, 2 idle slot-minutes')).toHaveAttribute('role', 'img');
  expect(screen.getByLabelText('alpha: ran at 100% of target, 0 idle slot-minutes')).toBeInTheDocument();
  expect(within(screen.getByText('codex').closest('li')!).getByText(/1 held min/)).toBeInTheDocument();
  expect(screen.getByLabelText('Workers and leaders over time')).toBeInTheDocument();
  expect(screen.getByText('No launch gaps observed.')).toBeInTheDocument();
});

it('explains a missing route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetCapacityPane visible />);
  expect(await screen.findByText('Capacity history has not landed in this build yet.')).toBeInTheDocument();
});

it('requests a separate window when selected', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
  render(<FleetCapacityPane visible />);
  await screen.findByText('24 h · 2 lanes · 3 samples · 0 launch gaps');
  fireEvent.click(screen.getByRole('button', { name: '6 h' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/verse/runs-history?hours=6', expect.anything()));
  expect(screen.getByRole('button', { name: '6 h' })).toHaveAttribute('aria-pressed', 'true');
});

it('retains the last reading when a refresh fails', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(fixture)).mockResolvedValueOnce(Response.json({}, { status: 500 }));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetCapacityPane visible />);
  await screen.findByText('24 h · 2 lanes · 3 samples · 0 launch gaps');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Capacity history could not refresh. Showing the last reading.')).toBeInTheDocument();
  expect(screen.getByLabelText(/codex: ran at/)).toBeInTheDocument();
});

it('polls only while pane, section and document are visible', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
  const view = render(<SectionVisibilityProvider visible><FleetCapacityPane visible /></SectionVisibilityProvider>);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'hidden'; act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { vi.advanceTimersByTime(120_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'visible'; await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(fetch).toHaveBeenCalledTimes(3);
  view.rerender(<SectionVisibilityProvider visible={false}><FleetCapacityPane visible /></SectionVisibilityProvider>);
  await act(async () => { vi.advanceTimersByTime(120_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
  view.rerender(<SectionVisibilityProvider visible><FleetCapacityPane visible={false} /></SectionVisibilityProvider>);
  await act(async () => { vi.advanceTimersByTime(120_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
});
