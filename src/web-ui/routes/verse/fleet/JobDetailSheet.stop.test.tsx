import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { JOB_CONTROL_PATH } from '../fleet-job-log/job-control-action.js';
import { fleetRunsFixture } from './fleet-runs-fixtures.test-support.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { JobDetailSheet } from './JobDetailSheet.js';

const job = 'RQ-PHX-FOO';
const detail = { schema: 'fleet.job.v1', job, state: 'running', lane: 'codex',
  log: { source: 'live', tail: ['working'] }, sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearMutationToken(); evictAll(); });
const lane = (name: string, running: number, held = false) =>
  ({ lane: name, running, target: 2, queued: 0, held, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const runs = { ...fleetRunsFixture({ lanes: [lane('codex', 1), lane('open-lane', 0), lane('held-lane', 0, true), lane('full-lane', 2)] }), claudeLane: null };
const receipt = (action: string, status: string) => ({ schema: 'fleet.job.control.v1', action, job, lane: null, status,
  reason: null, requestId: 'jc-0123456789ab', at: '2026-11-01T00:08:00.000Z', dryRun: false, duplicate: false });
function show(state = 'running') {
  vi.spyOn(client, 'apiGet').mockImplementation(async (path: string) => path === '/api/verse/fleet/runs' ? runs : { ...detail, state });
  render(<SectionVisibilityProvider visible><JobDetailSheet job={job} onClose={vi.fn()} /></SectionVisibilityProvider>);
}
async function confirm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Stop this job' }));
  const dialog = screen.getByRole('dialog', { name: `Stop ${job}?` });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, stop' }));
}
it('confirms and posts once, showing the outcome', async () => {
  const post = vi.spyOn(client, 'apiPost').mockResolvedValue(receipt('stop', 'applied'));
  show();
  await confirm();
  expect(await screen.findByText(`Stopped ${job}.`)).toBeInTheDocument();
  expect(post).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(JOB_CONTROL_PATH, { id: job, action: 'stop' }, 'a'.repeat(64));
});
it('pauses, resumes and moves without a confirm step, showing each receipt inline', async () => {
  const post = vi.spyOn(client, 'apiPost').mockImplementation(async (_path, body) => {
    const { action, lane } = body as { action: 'pause' | 'resume' | 'move'; lane?: string };
    return action === 'move' ? { ...receipt(action, 'refused'), lane, reason: `Lane ${lane} is held.` } : receipt(action, 'requested');
  });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Pause this job' }));
  expect(await screen.findByText(`Pause requested for ${job}.`)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume this job' }));
  expect(await screen.findByText(`Resume requested for ${job}.`)).toBeInTheDocument();
  const select = screen.getByRole('combobox', { name: 'Move this job to another lane' });
  expect([...select.querySelectorAll('option')].map(option => [option.textContent, option.disabled]))
    .toEqual([['Move to…', false], ['open-lane', false], ['held-lane (held)', true], ['full-lane (full)', true]]);
  fireEvent.change(select, { target: { value: 'open-lane' } });
  expect(await screen.findByText('Lane open-lane is held.')).toBeInTheDocument();
  expect(post).toHaveBeenLastCalledWith(JOB_CONTROL_PATH, { id: job, action: 'move', lane: 'open-lane' }, 'a'.repeat(64));
  expect(screen.queryByRole('dialog', { name: `Stop ${job}?` })).not.toBeInTheDocument();
});
it('shows the locked control message without posting', async () => {
  clearMutationToken();
  const post = vi.spyOn(client, 'apiPost');
  show();
  await confirm();
  expect(await screen.findByText('Unlock actions with the mutation token before changing the loop.')).toBeInTheDocument();
  expect(post).not.toHaveBeenCalled();
});
it('does not offer stop for a finished job', async () => {
  show('published');
  await screen.findByText('published');
  for (const name of ['Pause this job', 'Resume this job', 'Stop this job']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
});
