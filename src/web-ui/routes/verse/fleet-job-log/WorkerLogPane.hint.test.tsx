import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { WorkerLogPane } from './WorkerLogPane.js';
import type { FleetJobDetailV1 } from './worker-log-model.js';

const runs = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [],
  workers: [{ job: 'RQ-FAKE', repo: 'example', lane: 'devin', tier: 'mid', ageSeconds: 2520 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
} satisfies FleetRuns;
const base: FleetJobDetailV1 = { schema: 'fleet.job.v1', job: 'RQ-FAKE', state: 'running', lane: 'devin' };

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T12:00:00Z')); });
afterEach(() => { vi.restoreAllMocks(); evictAll(); });

it.each([
  [{ ...base, launchedAt: '2026-10-31T11:18:00Z', log: { source: 'live', bytes: 0 } }, 'Devin writes its log when the job ends (running 42 min). Watch the PR link above instead.'],
  [{ ...base, launchedAt: null, log: { source: 'missing' } }, 'Devin writes its log when the job ends. Watch the PR link above instead.'],
  [{ ...base, lane: 'codex', log: { source: 'live', bytes: 0 } }, 'Log is open but empty so far.'],
  [{ ...base, state: 'published', log: null }, 'This job ended without a log.'],
  [{ ...base, lane: 'codex', log: { source: 'missing' } }, 'No log yet.'],
] satisfies [FleetJobDetailV1, string][])('renders the appropriate hint for a job', async (detail, expected) => {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? runs : detail);
  render(<WorkerLogPane visible />);
  expect(await screen.findByText(expected)).toBeInTheDocument();
  expect(screen.queryByRole('log')).not.toBeInTheDocument();
});

it('continues to render a populated log', async () => {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? runs : { ...base, log: { source: 'live', bytes: 4, tail: ['done'] } });
  render(<WorkerLogPane visible />);
  expect(await screen.findByRole('log')).toHaveTextContent('done');
});
