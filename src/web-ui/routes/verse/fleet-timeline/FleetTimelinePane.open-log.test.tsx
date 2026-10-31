import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { FleetTimelinePane } from './FleetTimelinePane.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const fixture: FleetRunsV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 2, target: 3, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [
    { job: 'RQ-PHX-FOO', repo: 'example/repo', lane: 'codex', tier: 'work', ageSeconds: 3000 },
    { job: 'bad id', repo: 'example/repo', lane: 'codex', tier: 'work', ageSeconds: 1200 },
  ],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => {
  evictAll();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/api/verse/fleet/runs')) return Response.json(fixture);
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens a valid bar or the longest job and ignores an invalid bar', async () => {
  render(<FleetTimelinePane visible />);
  const valid = await screen.findByRole('button', { name: 'codex 2/3: RQ-PHX-FOO' });
  fireEvent.click(valid);
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-FOO');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  expect(vi.mocked(requestWorkerLogJob).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openDockPane).mock.invocationCallOrder[0]!);
  vi.clearAllMocks();
  fireEvent.click(screen.getByRole('button', { name: 'codex 2/3: bad id' }));
  expect(requestWorkerLogJob).not.toHaveBeenCalled();
  expect(openDockPane).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'RQ-PHX-FOO' }));
  expect(requestWorkerLogJob).toHaveBeenCalledOnce();
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-FOO');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
});

it('ignores an invalid longest job', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ ...fixture, workers: [{ ...fixture.workers[1], ageSeconds: 4000 }] }));
  render(<FleetTimelinePane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'bad id' }));
  expect(requestWorkerLogJob).not.toHaveBeenCalled();
  expect(openDockPane).not.toHaveBeenCalled();
});
