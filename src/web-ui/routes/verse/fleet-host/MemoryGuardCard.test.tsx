import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { memoryView } from '../../../../core/fleet/memory-view.js';
import { evictAll } from '../../../data/cache.js';
import { MemoryGuardCard } from './MemoryGuardCard.js';

const NOW = 1793589510 * 1000;
const MEMSTAT = { schema: 'ashlr.memstat.v1', ts: NOW / 1000 - 30, free_pct: 58, swap_gb: 0, swapouts_per_min: 0, disk_gb: 601 };

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function serve(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
}
const respond = (memstat: unknown, memguard: unknown) =>
  serve({ v: 1, generatedAt: new Date(NOW).toISOString(), memory: memoryView(memstat, memguard, NOW) });

it('renders the guard lines and stopped workers for a holding guard', async () => {
  respond(MEMSTAT, { stopped: { '4242': 'RQ-PHX-A' }, calm: 8, omlx_down: false });
  render(<MemoryGuardCard visible />);
  expect(await screen.findByText('Memory free 58% · disk free 601 GB')).toBeInTheDocument();
  expect(screen.getByText('Swap 0 GB · 0 swapouts/min')).toBeInTheDocument();
  expect(screen.getByText('oMLX loaded')).toBeInTheDocument();
  expect(screen.getByText('Guard calm 8')).toBeInTheDocument();
  expect(screen.getByText('RQ-PHX-A')).toHaveAttribute('data-tone', 'warn');
});

it('shows the stale banner when the sample is old', async () => {
  respond({ ...MEMSTAT, ts: (NOW - 10 * 60_000) / 1000 }, { stopped: {} });
  render(<MemoryGuardCard visible />);
  expect(await screen.findByText('Memory sample is 10 min old. The guard may not be running.')).toBeInTheDocument();
  expect(screen.getByText('Stopped workers: unknown')).toBeInTheDocument();
});

it('keeps unknown fields unknown when the files are missing', async () => {
  respond(null, null);
  render(<MemoryGuardCard visible />);
  expect(await screen.findByText('Memory free unknown · disk free unknown')).toBeInTheDocument();
  expect(screen.getByText('oMLX unknown')).toBeInTheDocument();
});

it('renders nothing when the route is absent', async () => {
  serve({}, 404);
  const { container } = render(<MemoryGuardCard visible />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
  expect(screen.queryByText('Memory guard')).not.toBeInTheDocument();
});
