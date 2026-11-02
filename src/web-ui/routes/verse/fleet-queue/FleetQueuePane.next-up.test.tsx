import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetQueuePane } from './FleetQueuePane.js';

vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const fixture = (): FleetQueueV1 => ({
  v: 1, generatedAt: '2026-01-01T00:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 5, ready: 4, parked: 1, malformed: 0, skipsLast24h: 0,
  byLane: [{ lane: 'codex-local', ready: 1, parked: 0 }, { lane: 'devin', ready: 3, parked: 1 }],
  nextUp: [{ lane: 'devin', jobs: ['RQ-AAA', 'RQ-BBB', 'RQ-CCC'] }],
  groups: [], skips: [],
});

const stubFetch = (queue: FleetQueueV1) => vi.stubGlobal('fetch',
  vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? { lanes: [] } : queue)));

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the next ready job ids for a lane and opens their worker logs', async () => {
  stubFetch(fixture());
  const openPane = vi.fn();
  render(<FleetQueuePane {...({ visible: true, host: { openPane } } as unknown as PaneProps)} />);

  const lane = (await screen.findByText('devin: 3 ready · 1 parked')).closest('li')!;
  const next = within(lane).getByTestId('lane-next');
  expect(next).toHaveTextContent('Next: RQ-AAA, RQ-BBB, RQ-CCC');

  fireEvent.click(within(next).getByLabelText('Open log for RQ-BBB'));
  expect(requestWorkerLogJob).toHaveBeenLastCalledWith('RQ-BBB');
  expect(openPane).toHaveBeenLastCalledWith('worker-log');
});

it('shows no next line for a lane absent from nextUp', async () => {
  stubFetch(fixture());
  render(<FleetQueuePane {...({ visible: true } as PaneProps)} />);

  const lane = (await screen.findByText('codex-local: 1 ready · 0 parked')).closest('li')!;
  expect(within(lane).queryByTestId('lane-next')).not.toBeInTheDocument();
  expect(screen.getAllByTestId('lane-next')).toHaveLength(1);
});

it('renders without nextUp from an older server', async () => {
  const queue = fixture();
  delete queue.nextUp;
  stubFetch(queue);
  render(<FleetQueuePane {...({ visible: true } as PaneProps)} />);

  expect(await screen.findByText('devin: 3 ready · 1 parked')).toBeInTheDocument();
  expect(screen.queryByTestId('lane-next')).not.toBeInTheDocument();
});
