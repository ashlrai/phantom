import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';

const now = Date.now();
const lanes = [
  { lane: 'codex-personal', running: 0, target: 14, queued: 16, held: true },
  { lane: 'devin', running: 0, target: 4, queued: 3, held: false },
];
const history = {
  v: 1, generatedAt: new Date(now).toISOString(), from: new Date(now - 60 * 60_000).toISOString(), to: new Date(now).toISOString(), sourceState: 'healthy', dropped: 0,
  samples: [{ at: new Date(now).toISOString(), workers: 1, leaders: 1, paused: false, lanes }],
};
const truth = {
  v: 1, generatedAt: new Date(now).toISOString(), source: 'ok', maxAgeMs: 15 * 60_000,
  lanes: [
    { lane: 'codex-personal', verdict: 'held_with_capacity', target: 14, running: 0, queued: 16, held: true,
      meter: { provider: 'codex-personal', usedPercent: 1, resetAt: '2026-11-07T12:00:00.000Z', sampledAt: new Date(now).toISOString() },
      reason: 'held while its meter shows available capacity' },
    { lane: 'devin', verdict: 'idle_with_work', target: 4, running: 0, queued: 3, held: false, meter: null,
      reason: 'queued work is waiting while nothing is running' },
  ],
};

function stubFetch(truthBody: unknown = truth, truthStatus = 200) {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith('/runs-history/lane-truth')) return Response.json(truthBody, { status: truthStatus });
    if (u.endsWith('/fleet/runs')) return Response.json({ lanes });
    return Response.json(history);
  }));
}
const laneRow = (name: string) => screen.getByRole('button', { name: `Open ${name} in Lanes` }).closest('li')!;

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows a verdict line under each flagged lane and the attention headline', async () => {
  stubFetch();
  render(<FleetCapacityPane visible />);
  expect(await screen.findByTestId('lane-truth-headline'))
    .toHaveTextContent('2 lanes need attention: codex-personal held with capacity, devin idle with work.');
  const personal = within(laneRow('codex-personal')).getByTestId('lane-truth');
  expect(personal).toHaveTextContent('Held with capacity: codex-personal is held while its meter shows 1% used (resets Nov 7).');
  expect(personal).toHaveAttribute('data-tone', 'bad');
  const devin = within(laneRow('devin')).getByTestId('lane-truth');
  expect(devin).toHaveTextContent('Idle with work: 0 of 4 running, 3 queued.');
  expect(devin).toHaveAttribute('data-tone', 'bad');
});

it('renders no verdict lines when every lane is ok', async () => {
  stubFetch({ ...truth, lanes: truth.lanes.map((row) => ({ ...row, verdict: 'ok' })) });
  render(<FleetCapacityPane visible />);
  await screen.findByText(/lanes · 1 sample/);
  expect(screen.queryByTestId('lane-truth')).not.toBeInTheDocument();
  expect(screen.queryByTestId('lane-truth-headline')).not.toBeInTheDocument();
});

it('renders nothing when the route is missing, without disturbing history', async () => {
  stubFetch({}, 404);
  render(<FleetCapacityPane visible />);
  expect(await screen.findByText(/lanes · 1 sample/)).toBeInTheDocument();
  expect(screen.queryByTestId('lane-truth')).not.toBeInTheDocument();
  expect(screen.queryByTestId('lane-truth-headline')).not.toBeInTheDocument();
});

it('renders nothing when the source is unavailable', async () => {
  stubFetch({ ...truth, source: 'unavailable', lanes: [] });
  render(<FleetCapacityPane visible />);
  await screen.findByText(/lanes · 1 sample/);
  expect(screen.queryByTestId('lane-truth')).not.toBeInTheDocument();
  expect(screen.queryByTestId('lane-truth-headline')).not.toBeInTheDocument();
});
