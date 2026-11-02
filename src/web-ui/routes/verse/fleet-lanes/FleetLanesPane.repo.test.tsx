import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetLanesPane } from './FleetLanesPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [
    { job: 'phantom-job', repo: 'ashlrai/phantom', lane: 'codex', tier: 'work', ageSeconds: 10 },
    { job: 'filler-job', repo: 'acme/filler-repo', lane: 'codex', tier: 'work', ageSeconds: 20 },
  ], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows each repository and identifies filler in the worker mix', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/api/verse/fleet/runs')
    ? Response.json(fixture) : new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<FleetLanesPane visible />);
  expect(await screen.findByLabelText('Repository mix')).toHaveTextContent('1 of 2 on phantom · others: filler-repo 1');
  const workers = screen.getByRole('heading', { name: 'Workers' }).parentElement!;
  expect(within(workers).getByText('phantom')).toHaveAttribute('title', 'ashlrai/phantom');
  expect(within(workers).getByText('filler-repo')).toHaveAttribute('title', 'acme/filler-repo');
  expect(container.querySelectorAll('[data-filler="true"]')).toHaveLength(1);
  expect(within(workers).getByText('filler-repo').closest('li')).toHaveAttribute('data-filler', 'true');
  expect(within(workers).queryByRole('link')).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith('/api/verse/fleet/runs', expect.anything());
});
