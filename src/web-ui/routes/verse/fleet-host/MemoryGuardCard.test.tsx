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


function sessionsResponse(offset: number, knownEmpty = false) {
  return { v: 1, generatedAt: new Date(NOW).toISOString(), memory: memoryView(MEMSTAT, {}, NOW, {
    schemaVersion: 1, observedAt: new Date(NOW + offset).toISOString(), pressure: { state: 'normal', level: 1 },
    censusState: 'known', sessionsState: 'known', sessions: knownEmpty ? [] : [
      { jobId: 'RQ-synthetic', state: 'known', processCount: 2, rssBytes: 1024, cpuPercentOneCore: 50, cpuPercentHost: 5, swapBytes: null },
    ], disk: { state: 'history', allocatedBytes: 1024, ageSeconds: 0, provenance: 'historical allocation' },
  }) };
}
it('labels a future clock without negative seconds or current normal pressure', async () => {
  serve(sessionsResponse(1000)); render(<MemoryGuardCard visible />);
  expect(await screen.findByText(/clock is ahead; measurements unavailable/)).toBeInTheDocument();
  expect(screen.queryByText(/-1s old/)).not.toBeInTheDocument();
  expect(screen.queryByText(/pressure normal/)).not.toBeInTheDocument();
  expect(screen.queryByText(/RQ-synthetic:/)).not.toBeInTheDocument();
});
it('labels stale outer evidence and advances its disk history age', async () => {
  serve(sessionsResponse(-61000)); render(<MemoryGuardCard visible />);
  expect(await screen.findByText(/Session observation: stale/)).toBeInTheDocument();
  expect(screen.getByText(/stale · 61s old · historical allocation/)).toBeInTheDocument();
  expect(screen.queryByText(/pressure normal/)).not.toBeInTheDocument();
  expect(screen.queryByText(/RQ-synthetic:/)).not.toBeInTheDocument();
});
it('distinguishes verified empty measurements and rejects a null known metric before rendering', async () => {
  serve(sessionsResponse(0, true)); const mounted = render(<MemoryGuardCard visible />);
  expect(await screen.findByText('Session measurements: none (verified empty)')).toBeInTheDocument();
  mounted.unmount(); evictAll();
  const malformed = sessionsResponse(0); malformed.memory.resource_session!.sessions[0]!.rssBytes = null;
  serve(malformed); const { container } = render(<MemoryGuardCard visible />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});
