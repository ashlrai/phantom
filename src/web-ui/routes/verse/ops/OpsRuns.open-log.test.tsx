import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { OpsRuns } from './OpsRuns.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('opens the selected worker log only for valid job IDs', async () => {
  const worker = { repo: 'phantom', lane: 'codex', tier: 'frontier', ageSeconds: 65 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/verse/fleet/runs')) return Response.json({
      v: 1, generatedAt: '2026-10-31T12:00:00Z',
      sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
      lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
      lanes: [], workers: [{ ...worker, job: 'RQ-PHX-FOO' }, { ...worker, job: 'bad id' }],
      leaders: [], orchestratorAgents: 0, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
      events: [], codexPersonal: null, inbox: [], drop: { pending: [], done: 0 },
    });
    return Response.json({}, { status: 404 });
  }));
  render(<OpsRuns />);
  const button = await screen.findByRole('button', { name: 'Open log for RQ-PHX-FOO' });
  const workers = within(screen.getByRole('table', { name: 'Workers' }));
  expect(workers.getByText('bad id').tagName).toBe('TH');
  expect(workers.queryByRole('button', { name: /bad id/ })).toBeNull();
  fireEvent.click(button);
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-FOO');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  expect(vi.mocked(requestWorkerLogJob).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openDockPane).mock.invocationCallOrder[0]);
});
