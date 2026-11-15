import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import * as client from '../../../data/client.js';
import { JOB_STOP_PATH } from '../fleet-job-log/job-stop-action.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { JobDetailSheet } from './JobDetailSheet.js';

const job = 'RQ-PHX-FOO';
const detail = { schema: 'fleet.job.v1', job, state: 'running', lane: 'codex',
  log: { source: 'live', tail: ['working'] }, sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearMutationToken(); evictAll(); });
function show(state = 'running') {
  vi.spyOn(client, 'apiGet').mockResolvedValue({ ...detail, state });
  render(<SectionVisibilityProvider visible><JobDetailSheet job={job} onClose={vi.fn()} /></SectionVisibilityProvider>);
}
async function confirm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Stop this job' }));
  const dialog = screen.getByRole('dialog', { name: `Stop ${job}?` });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, stop' }));
}
it('confirms and posts once, showing the outcome', async () => {
  const post = vi.spyOn(client, 'apiPost').mockResolvedValue({ id: job, pids: [1], outcome: 'stopped', at: '' });
  show();
  await confirm();
  expect(await screen.findByText('stopped 1 process')).toBeInTheDocument();
  expect(post).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledWith(JOB_STOP_PATH, { id: job }, 'a'.repeat(64));
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
  expect(screen.queryByRole('button', { name: 'Stop this job' })).not.toBeInTheDocument();
});
