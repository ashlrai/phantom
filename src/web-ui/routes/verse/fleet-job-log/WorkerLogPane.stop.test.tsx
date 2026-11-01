import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { JOB_STOP_PATH, type JobStopResult } from './job-stop-action.js';
import { WorkerLogPane } from './WorkerLogPane.js';

const job = 'RQ-PHX-EXAMPLE31';
const runs = { ...fleetRunsFixture({ workers: [{ job, repo: 'fake/repo', lane: 'codex', tier: 'mid', ageSeconds: 60 }] }), claudeLane: null };
const running = { schema: 'fleet.job.v1', job, state: 'running', lane: 'codex', log: { source: 'live', tail: ['working'] } };
const finished = { ...running, state: 'published', log: { source: 'archived', tail: ['done'] } };
const stopped: JobStopResult = { id: job, pids: [111, 222], outcome: 'stopped', at: '2026-11-01T00:08:00.000Z' };

beforeEach(() => { evictAll(); vi.clearAllMocks(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearMutationToken(); evictAll(); });

function serve(detail: unknown) {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? runs : detail);
}

it('offers no Stop button for a finished job', async () => {
  serve(finished);
  render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  expect(screen.queryByRole('button', { name: 'Stop this job' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Steer this job' })).toBeInTheDocument();
});

it('arms on the first click, posts once on the second, and shows the outcome', async () => {
  serve(running);
  const post = vi.spyOn(client, 'apiPost').mockResolvedValue(stopped);
  render(<WorkerLogPane visible />);
  const button = await screen.findByRole('button', { name: 'Stop this job' });
  expect(button).toHaveTextContent('Stop');
  fireEvent.click(button);
  expect(await screen.findByText(`Stop ${job}? click again`)).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(await screen.findByText('stopped 2 processes')).toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(JOB_STOP_PATH, { id: job }, 'a'.repeat(64));
});

it('shows not running and the control-token text when the post cannot go through', async () => {
  serve(running);
  vi.spyOn(client, 'apiPost').mockRejectedValue(new client.ApiError('POST failed (HTTP 409).', 409, JOB_STOP_PATH));
  render(<WorkerLogPane visible />);
  const button = await screen.findByRole('button', { name: 'Stop this job' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(await screen.findByText('not running')).toBeInTheDocument();
  clearMutationToken();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(await screen.findByText('Unlock actions with the mutation token before changing the loop.')).toBeInTheDocument();
});
