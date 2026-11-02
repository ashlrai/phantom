import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { WorkerLogPane } from './WorkerLogPane.js';
import { requestWorkerLogJob, resetWorkerLogSelection, takeRequestedWorkerLogJob } from './worker-log-selection.js';

const runs = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
  workers: [{ job: 'RQ-OTHER', repo: 'phantom', lane: 'codex', tier: 'mid', ageSeconds: 60 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => { evictAll(); resetWorkerLogSelection(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); evictAll(); resetWorkerLogSelection(); });

it('loads the requested worker log when the pane opens', async () => {
  const api = vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs'
    ? runs
    : { schema: 'fleet.job.v1', log: { source: 'live', tail: ['requested log'] } });
  requestWorkerLogJob('RQ-PHX-EXAMPLE1');
  render(<WorkerLogPane visible />);
  expect(screen.getByRole('textbox', { name: 'Job ID' })).toHaveValue('RQ-PHX-EXAMPLE1');
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/fleet/job?id=RQ-PHX-EXAMPLE1', undefined));
  expect(await screen.findByRole('log')).toHaveTextContent('requested log');
  expect(takeRequestedWorkerLogJob()).toBeNull();
});

it('switches an already mounted pane and consumes a repeated selection', async () => {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs'
    ? { ...runs, workers: [] }
    : { schema: 'fleet.job.v1', log: { source: 'live', tail: ['log'] } });
  render(<WorkerLogPane visible />);
  act(() => requestWorkerLogJob('RQ-PHX-EXAMPLE1'));
  expect(screen.getByRole('textbox', { name: 'Job ID' })).toHaveValue('RQ-PHX-EXAMPLE1');
  act(() => requestWorkerLogJob('RQ-PHX-EXAMPLE1'));
  expect(takeRequestedWorkerLogJob()).toBeNull();
});
