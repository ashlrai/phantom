import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { openInterjectDialog } from './interject-dialog-store.js';
import { JobDetailSheet } from './JobDetailSheet.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));
vi.mock('./interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const url = 'https://github.com/example/repo/pull/12';
const detail = { schema: 'fleet.job.v1', job: 'RQ-PHX-FOO', state: 'running', lane: 'codex-personal',
  publish: { prUrl: url }, log: { source: 'live', tail: ['Log line'] },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
beforeEach(() => { evictAll(); vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(detail))); });
afterEach(() => { vi.unstubAllGlobals(); evictAll(); });

it('opens the worker log and closes the sheet before details arrive', () => {
  const onClose = vi.fn();
  render(<SectionVisibilityProvider visible><JobDetailSheet job="RQ-PHX-FOO" onClose={onClose} /></SectionVisibilityProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open worker log' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('RQ-PHX-FOO');
  expect(openDockPane).toHaveBeenCalledWith('worker-log');
  expect(onClose).toHaveBeenCalledOnce();
});

it('offers the published PR and steers with the job and lane', async () => {
  const onClose = vi.fn();
  render(<SectionVisibilityProvider visible><JobDetailSheet job="RQ-PHX-FOO" onClose={onClose} /></SectionVisibilityProvider>);
  const group = screen.getByRole('group', { name: 'Job actions' });
  expect(await within(group).findByRole('link', { name: 'Open PR #12' })).toHaveAttribute('href', url);
  expect(fetch).toHaveBeenCalledWith('/api/fleet/job?id=RQ-PHX-FOO', expect.anything());
  fireEvent.click(within(group).getByRole('button', { name: 'Steer this worker' }));
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: 'Re RQ-PHX-FOO (codex-personal): ' });
  expect(onClose).toHaveBeenCalledOnce();
});
