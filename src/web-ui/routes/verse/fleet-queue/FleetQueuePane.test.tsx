import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetQueuePane } from './FleetQueuePane.js';

const props = { visible: true } as PaneProps;
const fixture = (): FleetQueueV1 => ({
  v: 1, generatedAt: '2026-01-01T00:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 3, ready: 1, parked: 2, malformed: 0, skipsLast24h: 1,
  byLane: [{ lane: 'a', ready: 1, parked: 2 }],
  groups: [{ reason: 'BYHAND', lane: 'a', count: 2, jobs: ['RQ-1', 'RQ-2'] }],
  skips: [{ at: '2026-01-01T00:00:00Z', job: 'RQ-3', code: 'other', reason: 'Already queued' }],
});
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders counts, parked groups and precheck skips', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture())));
  render(<FleetQueuePane {...props} />);
  expect(await screen.findByText('3 jobs · 1 ready · 2 parked · 1 precheck skips in 24 h')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'By lane' })).getByText('a: 1 ready · 2 parked')).toBeInTheDocument();
  expect(screen.getByText('Parked by hand · a · 2')).toBeInTheDocument();
  expect(screen.getByText('RQ-1, RQ-2')).toBeInTheDocument();
  expect(screen.getByText('RQ-3 · other · Already queued')).toBeInTheDocument();
});

it('reports a missing endpoint', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
  render(<FleetQueuePane {...props} />);
  expect(await screen.findByText('Queue not in this build')).toBeInTheDocument();
});

it('reports a degraded source', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...fixture(), sources: { ready: 'healthy', skips: 'degraded' } })));
  render(<FleetQueuePane {...props} />);
  expect(await screen.findByText('Queue data may be incomplete.')).toBeInTheDocument();
});
