import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { LaunchStallViewV1 } from '../../../../core/verse/fleet-launch-stall-api.js';
import { LaunchStallBanner } from './LaunchStallBanner.js';

const quiet: LaunchStallViewV1 = {
  v: 1, generatedAt: '2026-11-09T12:00:00Z', source: 'ok', lanes: [],
  stall: { startTime: null, minutes: null, lastQ: null, lastReap: null, min: 30, stalled: false },
};
const REUSE = 'Only repair jobs can start: 41 GB free on the runs disk, under the 100 GB guard. 2 jobs are waiting for disk.';
const LOADGATE_OFF = 'Load gate is switched off (LOADGATE_OFF); launches are not blocked by load.';

const serve = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
const fetched = () => waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows the disk reuse-only reason while the stall detector has not fired', async () => {
  serve({ ...quiet, why: { code: 'disk-reuse-only', line: REUSE, detail: [LOADGATE_OFF] } });
  render(<LaunchStallBanner enabled />);
  expect(await screen.findByText(REUSE)).toBeInTheDocument();
  expect(screen.getByText(LOADGATE_OFF)).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Launch stall' })).toBeInTheDocument();
});

it('keeps the stall line alongside the reason', async () => {
  serve({
    ...quiet, why: { code: 'at-cap', line: 'All 18 slots are in use.', detail: [] },
    stall: { startTime: '2026-11-09T10:00:00.000-05:00', minutes: 42, lastQ: 5, lastReap: 0, min: 30, stalled: true },
  });
  render(<LaunchStallBanner enabled />);
  expect(await screen.findByText('All 18 slots are in use.')).toBeInTheDocument();
  expect(screen.getByText('No job has launched for 42 min. 5 jobs are queued.')).toBeInTheDocument();
});

it('shows nothing when the code is none and nothing is stuck', async () => {
  serve({ ...quiet, why: { code: 'none', line: 'Nothing is blocking launches.', detail: [LOADGATE_OFF] } });
  const { container } = render(<LaunchStallBanner enabled />);
  await fetched(); await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

it('still works on an old response without why, and with why null', async () => {
  for (const body of [quiet, { ...quiet, why: null }]) {
    evictAll();
    serve({ ...body, lanes: [{ lane: 'devin', jobs: [{ job: 'RQ-FAKE-D', ageMinutes: 47 }] }] });
    const { unmount } = render(<LaunchStallBanner enabled />);
    expect(await screen.findByRole('button', { name: 'Show lane devin' })).toBeInTheDocument();
    unmount();
  }
});

it('rejects a malformed why', async () => {
  serve({ ...quiet, why: { code: 'dispatch-off', line: 'x', detail: [] } });
  const { container } = render(<LaunchStallBanner enabled />);
  await fetched(); await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});
