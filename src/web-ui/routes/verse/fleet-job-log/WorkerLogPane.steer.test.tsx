import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { WorkerLogPane } from './WorkerLogPane.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const job = 'RQ-PHX-EXAMPLE31';
const runs = { ...fleetRunsFixture({ workers: [{ job, repo: 'fake/repo', lane: 'codex', tier: 'mid', ageSeconds: 60 }] }), claudeLane: null };
beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); evictAll(); });

it('opens an interjection for the selected job using its detail lane', async () => {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs'
    ? runs : { schema: 'fleet.job.v1', lane: 'devin', log: { source: 'live', tail: ['working'] } });
  render(<WorkerLogPane visible />);
  await screen.findByRole('log');
  fireEvent.click(screen.getByRole('button', { name: 'Steer this job' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Re RQ-PHX-EXAMPLE31 (devin): ' });
});

it('uses the matching worker lane while detail is loading', async () => {
  vi.spyOn(client, 'apiGet').mockImplementation((path: string) => path === '/api/verse/fleet/runs'
    ? Promise.resolve(runs) : new Promise(() => {}));
  render(<WorkerLogPane visible />);
  await screen.findByRole('option', { name: /RQ-PHX-EXAMPLE31/ });
  fireEvent.click(screen.getByRole('button', { name: 'Steer this job' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Re RQ-PHX-EXAMPLE31 (codex): ' });
});

it('disables steering when no job is selected or the job is invalid', async () => {
  vi.spyOn(client, 'apiGet').mockResolvedValue({ ...fleetRunsFixture({ workers: [] }), claudeLane: null });
  render(<WorkerLogPane visible />);
  const button = screen.getByRole('button', { name: 'Steer this job' });
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Job ID' }), { target: { value: '../bad' } });
  expect(button).toBeDisabled();
  expect(openInterjectDialog).not.toHaveBeenCalled();
});
