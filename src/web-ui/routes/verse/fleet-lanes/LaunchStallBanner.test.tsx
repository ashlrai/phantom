import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { LaunchStallViewV1 } from '../../../../core/verse/fleet-launch-stall-api.js';
import { resetLaneFocus, takeRequestedLane } from './lane-focus-request.js';
import { LaunchStallBanner } from './LaunchStallBanner.js';

const quiet: LaunchStallViewV1 = {
  v: 1, generatedAt: '2026-11-09T12:00:00Z', source: 'ok', lanes: [],
  stall: { startTime: null, minutes: null, lastQ: null, lastReap: null, min: 30, stalled: false },
};
const stuck: LaunchStallViewV1 = {
  ...quiet,
  stall: { startTime: '2026-11-09T10:00:00.000-05:00', minutes: 42.2, lastQ: 37, lastReap: 0, min: 30, stalled: true },
  lanes: [
    { lane: 'codex-personal', jobs: [{ job: 'RQ-FAKE-A', ageMinutes: 61.4 }, { job: 'RQ-FAKE-B', ageMinutes: 50 }, { job: 'RQ-FAKE-C', ageMinutes: 46 }] },
    { lane: 'devin', jobs: [{ job: 'RQ-FAKE-D', ageMinutes: 47 }] },
  ],
};

const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
const fetched = () => waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());

beforeEach(() => { evictAll(); resetLaneFocus(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('is hidden when nothing is stalled', async () => {
  serve(quiet);
  const { container } = render(<LaunchStallBanner enabled />);
  await fetched(); await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

it('renders the stall sentence and one row per stuck lane', async () => {
  serve(stuck);
  render(<LaunchStallBanner enabled />);
  expect(await screen.findByText('No job has launched for 42 min. 37 jobs are queued.')).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Launch stall' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show lane codex-personal' })).toHaveTextContent('codex-personal: 3 jobs waiting, oldest 61 min');
  expect(screen.getByRole('button', { name: 'Show lane devin' })).toHaveTextContent('devin: 1 job waiting, oldest 47 min');
});

it('a lane button asks the pane to focus that lane', async () => {
  serve(stuck);
  render(<LaunchStallBanner enabled />);
  fireEvent.click(await screen.findByRole('button', { name: 'Show lane devin' }));
  expect(takeRequestedLane()).toBe('devin');
});

it('says plainly when the dispatcher log is unreadable', async () => {
  serve({ ...quiet, source: 'unavailable', stall: null });
  render(<LaunchStallBanner enabled />);
  expect(await screen.findByText("Phantom can't read the dispatcher log on this computer.")).toBeInTheDocument();
  expect(screen.queryByText(/unknown/i)).toBeNull();
});

it('renders nothing when the route has not landed', async () => {
  serve({ error: 'not found' }, 404);
  const { container } = render(<LaunchStallBanner enabled />);
  await fetched(); await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});

it('renders nothing for an invalid response', async () => {
  serve({ v: 1, lanes: 'nope' });
  const { container } = render(<LaunchStallBanner enabled />);
  await fetched(); await act(async () => {});
  expect(container).toBeEmptyDOMElement();
});
