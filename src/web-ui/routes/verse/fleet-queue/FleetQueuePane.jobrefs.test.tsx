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
  total: 3, ready: 1, parked: 2, malformed: 0, skipsLast24h: 1,
  byLane: [{ lane: 'a', ready: 1, parked: 2 }],
  groups: [{ reason: 'BYHAND', lane: 'a', count: 2, jobs: ['RQ-ONE', 'RQ-TWO'] }],
  skips: [{ at: '2026-01-01T00:00:00Z', job: 'RQ-THREE', code: 'other', reason: 'Waiting for #1234 and RQ-FOUR' }],
});

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('opens parked and skipped job logs and links references in skip reasons', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  const openPane = vi.fn();
  render(<FleetQueuePane {...({ visible: true, host: { openPane } } as unknown as PaneProps)} />);

  const parked = await screen.findByRole('region', { name: 'Parked groups' });
  expect(parked).toHaveTextContent('Parked by hand · a · 2');
  expect(parked).toHaveTextContent('RQ-ONE, RQ-TWO');
  const skips = screen.getByRole('region', { name: 'Precheck skips' });
  expect(skips).toHaveTextContent('RQ-THREE · other · Waiting for #1234 and RQ-FOUR');
  expect(within(skips).getByRole('link', { name: '#1234' })).toHaveAttribute('href', 'https://github.com/ashlrai/phantom/pull/1234');

  for (const id of ['RQ-ONE', 'RQ-TWO', 'RQ-THREE', 'RQ-FOUR']) {
    fireEvent.click(screen.getByLabelText(`Open log for ${id}`));
    expect(requestWorkerLogJob).toHaveBeenLastCalledWith(id);
    expect(openPane).toHaveBeenLastCalledWith('worker-log');
  }
  expect(requestWorkerLogJob).toHaveBeenCalledTimes(4);
  expect(openPane).toHaveBeenCalledTimes(4);
});

it('preserves the parked job overflow text and ordering', async () => {
  const data = fixture();
  data.groups[0].jobs = Array.from({ length: 10 }, (_, i) => `RQ-${i + 1}`);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<FleetQueuePane {...({ visible: true } as PaneProps)} />);

  const parked = await screen.findByRole('region', { name: 'Parked groups' });
  expect(parked).toHaveTextContent('RQ-1, RQ-2, RQ-3, RQ-4, RQ-5, RQ-6, RQ-7, RQ-8 +2 more');
  expect(within(parked).getAllByRole('button')).toHaveLength(8);
});
