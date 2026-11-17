import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { JobControlReceiptV1 } from '../../../../core/fleet/job-control-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { JOB_CONTROL_PATH } from './job-control-action.js';
import { WorkerLogPane } from './WorkerLogPane.js';

const job = 'RQ-PHX-EXAMPLE31';
const lane = (name: string, running: number, target: number, held = false) =>
  ({ lane: name, running, target, queued: 0, held, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const runs = {
  ...fleetRunsFixture({
    workers: [{ job, repo: 'fake/repo', lane: 'codex', tier: 'mid', ageSeconds: 60 }],
    lanes: [lane('codex', 1, 2), lane('open-lane', 0, 2), lane('held-lane', 0, 2, true), lane('full-lane', 2, 2)],
  }),
  claudeLane: null,
};
const running = { schema: 'fleet.job.v1', job, state: 'running', lane: 'codex', log: { source: 'live', tail: ['working'] } };
const finished = { ...running, state: 'published', log: { source: 'archived', tail: ['done'] } };
const receipt = (over: Partial<JobControlReceiptV1>): JobControlReceiptV1 => ({
  schema: 'fleet.job.control.v1', action: 'pause', job, lane: null, status: 'requested', reason: null,
  requestId: 'jc-0123456789ab', at: '2026-11-01T00:08:00.000Z', dryRun: false, duplicate: false, ...over,
});

beforeEach(() => { evictAll(); vi.clearAllMocks(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearMutationToken(); evictAll(); });

function serve(detail: unknown) {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? runs : detail);
}

it('offers no job controls for a finished job', async () => {
  serve(finished);
  render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  for (const name of ['Pause this job', 'Resume this job', 'Stop this job']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Move this job to another lane' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Steer this job' })).toBeInTheDocument();
});

it('pauses and resumes in one click and shows the receipt inline', async () => {
  serve(running);
  const post = vi.spyOn(client, 'apiPost').mockImplementation(async (_path, body) => receipt({ action: (body as { action: 'pause' | 'resume' }).action }));
  render(<WorkerLogPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause this job' }));
  expect(await screen.findByText(`Pause requested for ${job}.`)).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith(JOB_CONTROL_PATH, { id: job, action: 'pause' }, 'a'.repeat(64));
  fireEvent.click(screen.getByRole('button', { name: 'Resume this job' }));
  expect(await screen.findByText(`Resume requested for ${job}.`)).toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(2);
});

it('asks first only for Stop, then posts once and shows the receipt', async () => {
  serve(running);
  const post = vi.spyOn(client, 'apiPost').mockResolvedValue(receipt({ action: 'stop', status: 'applied' }));
  render(<WorkerLogPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Stop this job' }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('dialog', { name: `Stop ${job}?` })).getByRole('button', { name: 'Yes, stop' }));
  expect(await screen.findByText(`Stopped ${job}.`)).toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(JOB_CONTROL_PATH, { id: job, action: 'stop' }, 'a'.repeat(64));
});

it('moves on lane choice, blocks held and full lanes, and shows a refusal as written', async () => {
  serve(running);
  const post = vi.spyOn(client, 'apiPost').mockResolvedValue(receipt({ action: 'move', lane: 'open-lane', status: 'refused', reason: 'Lane open-lane is held.' }));
  render(<WorkerLogPane visible />);
  const select = await screen.findByRole('combobox', { name: 'Move this job to another lane' });
  const options = [...select.querySelectorAll('option')].map(option => [option.textContent, option.disabled]);
  expect(options).toEqual([['Move to…', false], ['open-lane', false], ['held-lane (held)', true], ['full-lane (full)', true]]);
  fireEvent.change(select, { target: { value: 'open-lane' } });
  expect(await screen.findByText('Lane open-lane is held.')).toBeInTheDocument();
  expect(post).toHaveBeenCalledWith(JOB_CONTROL_PATH, { id: job, action: 'move', lane: 'open-lane' }, 'a'.repeat(64));
});

it('shows the control-token text when the post cannot go through', async () => {
  serve(running);
  clearMutationToken();
  render(<WorkerLogPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause this job' }));
  expect(await screen.findByText('Unlock actions with the mutation token before changing the loop.')).toBeInTheDocument();
});
