import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { DiskRunwayCard } from './DiskRunwayCard.js';

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function serve(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
}
const respond = (freeGb: number | null, rate: number | null, hoursToReuseOnly: number | null, status = 'projected') => serve({
  schema: 'fleet.disk-runway.v1', lines: { reuseOnlyGb: 100, hardStopGb: 30 }, hoursToReuseOnly, hoursToHardStop: null,
  forecast: { schema: 'fleet.disk-forecast.v1', status, thresholdGb: 150, samples: 2, freeGb, consumptionGbPerHour: rate,
    observedFrom: freeGb === null ? null : '2026-11-09T10:00:00.000Z', observedTo: freeGb === null ? null : '2026-11-09T12:00:00.000Z',
    hoursUntilThreshold: null, crossingAt: null, launchedJobs: null },
});

it('shows hours until the reuse-only line for a falling disk', async () => {
  respond(283, 26.1, 7.01);
  render(<DiskRunwayCard visible />);
  const head = await screen.findByText('Disk: 283 GB free');
  expect(head).toHaveAttribute('data-tone', 'ok');
  expect(screen.getByText('~7.0 h until new jobs are held')).toBeInTheDocument();
  expect(screen.getByText(/Sample window 2026-11-09T10:00:00.000Z to 2026-11-09T12:00:00.000Z · 26.1 GB\/h/)).toBeInTheDocument();
});

it('says not falling when the rate is not positive', async () => {
  respond(283, -0.5, null, 'not-falling');
  render(<DiskRunwayCard visible />);
  expect(await screen.findByText('not falling')).toBeInTheDocument();
});

it('goes red and says new jobs are held below 100 GB', async () => {
  respond(56, 3, 0, 'reached');
  render(<DiskRunwayCard visible />);
  const head = await screen.findByText('Disk: 56 GB free · new jobs are held (reuse-only)');
  expect(head).toHaveAttribute('data-tone', 'bad');
  expect(head).not.toHaveAttribute('data-severe');
  expect(screen.queryByText(/until new jobs are held/)).not.toBeInTheDocument();
});

it('goes stronger red and says no launches below 30 GB', async () => {
  respond(20, 3, 0, 'reached');
  render(<DiskRunwayCard visible />);
  const head = await screen.findByText('Disk: 20 GB free · no launches');
  expect(head).toHaveAttribute('data-tone', 'bad');
  expect(head).toHaveAttribute('data-severe', 'true');
});

it('shows unknown without inventing a number', async () => {
  respond(null, null, null, 'unknown');
  render(<DiskRunwayCard visible />);
  expect(await screen.findByText('Disk: free space unknown')).toHaveAttribute('data-tone', 'warn');
  expect(screen.getByText('unknown')).toBeInTheDocument();
  expect(screen.getByText(/Sample window unknown/)).toBeInTheDocument();
});

it('renders nothing when the route is absent', async () => {
  serve({}, 404);
  const { container } = render(<DiskRunwayCard visible />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});
