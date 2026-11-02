import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { toneColor } from '../../../components/charts/colors.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { busFeedQuery } from '../fleet/bus-feed-queries.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { FleetTimelinePane } from './FleetTimelinePane.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const now = Date.parse('2026-10-31T12:45:00Z');
const runs: FleetRunsV1 = {
  v: 1, generatedAt: '2026-10-31T12:45:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 2, target: 3, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [
    { job: 'first-job', repo: 'example/repo', lane: 'codex', tier: 'work', ageSeconds: 1800 },
    { job: 'second-job', repo: 'example/repo', lane: 'codex', tier: 'work', ageSeconds: 600 },
  ],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const bus = {
  v: 1, hops: [], hopsDropped: 0, lastHopAt: null, sources: { hops: 'healthy', events: 'healthy' },
  events: [
    { at: '2026-10-31T12:30:00Z', kind: 'inbox', text: 'INBOX Mason, start the next job' },
    { at: '2026-10-31T11:59:00Z', kind: 'inbox', text: 'INBOX too early' },
    { at: '2026-10-31T12:10:00Z', kind: 'inbox', text: 'INBOX Mason, inspect the fleet' },
  ],
};

function serve(busStatus = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/live/bus')
    ? Response.json(busStatus === 200 ? bus : {}, { status: busStatus })
    : Response.json(runs)));
}

beforeEach(() => { evictAll(); localStorage.clear(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('shows and routes interjections on the worker timeline in both layouts', async () => {
  serve();
  const { container } = render(<FleetTimelinePane visible />);
  const first = await screen.findByRole('button', { name: 'Mason: inspect the fleet' });
  expect(screen.getByRole('button', { name: 'Mason: start the next job' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Mason: too early' })).not.toBeInTheDocument();
  expect(screen.getByText(/2 interjections in view$/)).toBeInTheDocument();
  const lane = container.querySelector('g[data-lane="mason"]')!;
  expect(lane.parentElement?.querySelector('g[data-lane]')).toBe(lane);
  expect(lane.querySelectorAll('rect[data-status="interjection"]')).toHaveLength(2);
  expect(lane.querySelector('rect[data-status="interjection"]')).toHaveAttribute('fill', toneColor('warning'));
  fireEvent.pointerEnter(lane.querySelector('rect[data-status="interjection"]')!);
  expect(screen.getByText('inspect the fleet')).toBeInTheDocument();
  fireEvent.click(first);
  expect(openDockPane).toHaveBeenCalledWith('fleet-inbox');
  expect(requestWorkerLogJob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'codex 2/3: first-job' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('first-job');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');

  fireEvent.click(screen.getByRole('button', { name: 'Group by lane' }));
  expect(screen.getAllByLabelText('Mason: 2 runs (2 interjection)')).toHaveLength(1);
  expect(within(screen.getByRole('group', { name: /Mason: 2 runs across/ })).getAllByRole('button')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Mason: inspect the fleet' })).toBeInTheDocument();
});

it('hides the lane without an error when the bus refresh fails', async () => {
  let fail = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/live/bus')
    ? Response.json(fail ? {} : bus, { status: fail ? 500 : 200 })
    : Response.json(runs)));
  render(<FleetTimelinePane visible />);
  expect(await screen.findByRole('button', { name: 'Mason: inspect the fleet' })).toBeInTheDocument();
  fail = true;
  await act(async () => { await refetchQuery(busFeedQuery.key, () => busFeedQuery.fetch()); });
  expect(screen.queryByLabelText(/Mason:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/interjections in view/)).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'first-job' })).toBeInTheDocument();
});

it('leaves the worker timeline unchanged when the bus route is missing', async () => {
  serve(404);
  render(<FleetTimelinePane visible />);
  expect(await screen.findByRole('button', { name: 'first-job' })).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/live/bus'), expect.anything()));
  expect(screen.queryByLabelText(/Mason:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/interjections in view/)).not.toBeInTheDocument();
  expect(screen.getByText('Click a bar to open its log.')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
