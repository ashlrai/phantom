import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetSupplyQuery } from '../fleet-supply/fleet-supply-queries.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import { opsQueueQuery } from '../ops/ops-queue-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { dropJobsQuery } from './drop-job-queries.js';
import { FleetQueuePane } from './FleetQueuePane.js';
import styles from './fleet-queue.module.css';
import { laneHoldsQuery } from './queue-holds-model.js';

const queue: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T00:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 41, ready: 40, parked: 1, malformed: 0, skipsLast24h: 0,
  byLane: [{ lane: 'codex-personal', ready: 40, parked: 1 }],
  groups: [], skips: [],
};
const snapshot = { lanes: [{ lane: 'codex-personal', running: 6, target: 10, held: false }] };

beforeEach(() => {
  evictAll();
  vi.spyOn(opsQueueQuery, 'fetch').mockResolvedValue(queue);
  vi.spyOn(laneHoldsQuery, 'fetch').mockResolvedValue(null);
  vi.spyOn(dropJobsQuery, 'fetch').mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('renders the depth line for a deep queue with the warning style', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(snapshot);
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  const line = await screen.findByText('40 ready for 10 live slots (4x). Target is 2-3x: generators should hold.');
  expect(line).toHaveClass(styles.warning);
});

it('says capacity unknown when lane data fails to load', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockRejectedValue(new Error('offline'));
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  const line = await screen.findByText('40 ready · live capacity unknown.');
  expect(line).not.toHaveClass(styles.warning);
});
