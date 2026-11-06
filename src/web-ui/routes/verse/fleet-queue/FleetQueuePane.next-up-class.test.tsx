import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetQueuePane } from './FleetQueuePane.js';

vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const queue = (jobs: string[]): FleetQueueV1 => ({
  v: 1, generatedAt: '2026-10-31T00:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: jobs.length, ready: jobs.length, parked: 0, malformed: 0, skipsLast24h: 0,
  byLane: [{ lane: 'codex-personal', ready: jobs.length, parked: 0 }, { lane: 'devin', ready: 0, parked: 0 }],
  nextUp: [{ lane: 'codex-personal', jobs }], groups: [], skips: [],
});

function renderQueue(jobs: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? { lanes: [] } : queue(jobs))));
  const openPane = vi.fn();
  render(<FleetQueuePane {...({ visible: true, host: { openPane } } as unknown as PaneProps)} />);
  return openPane;
}

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows each class next to its job, summarizes the lane, and preserves log links', async () => {
  const openPane = renderQueue(['RQ-PHX-ABC01', 'RQ-FILL-2', 'RQ-PHX-DEF01']);
  const next = await screen.findByTestId('lane-next');
  expect(Array.from(next.querySelectorAll('[data-class]'), chip => [chip.textContent, chip.getAttribute('data-class')]))
    .toEqual([['Phantom', 'phx'], ['filler', 'filler'], ['Phantom', 'phx']]);
  expect(screen.getByText('next 3 on codex-personal: 2 Phantom, 1 filler')).toBeInTheDocument();
  expect(screen.queryByText('filler launches before Phantom work on codex-personal')).not.toBeInTheDocument();
  fireEvent.click(within(next).getByRole('button', { name: 'Open log for RQ-FILL-2' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-FILL-2');
  expect(openPane).toHaveBeenCalledWith('worker-log');
  const otherLane = screen.getByText('devin: 0 ready · 0 parked').closest('li')!;
  expect(within(otherLane).queryByTestId('lane-next')).not.toBeInTheDocument();
  expect(otherLane.querySelector('[data-class]')).toBeNull();
});

it('warns on the affected lane when filler will launch first', async () => {
  renderQueue(['RQ-FILL-2', 'RQ-PHX-DEF01']);
  expect(await screen.findByText('filler launches before Phantom work on codex-personal')).toBeInTheDocument();
  expect(screen.getByText('next 2 on codex-personal: 1 Phantom, 1 filler')).toBeInTheDocument();
});

it('leaves an empty next-up list unchanged', async () => {
  renderQueue([]);
  expect(await screen.findByText('codex-personal: 0 ready · 0 parked')).toBeInTheDocument();
  expect(screen.queryByTestId('lane-next')).not.toBeInTheDocument();
  expect(screen.queryByText('nothing next')).not.toBeInTheDocument();
});
