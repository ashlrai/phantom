import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { WorkerNote } from './WorkerNote.js';

const POST = 'POST /api/verse/fleet/runs/notes';
const GET = 'GET /api/verse/fleet/runs/notes';
const note = { id: 'n-1', at: '2026-11-01T00:05:00.000Z', text: 'also update the docs', by: 'cli' };
const listing = (notes: unknown[]) => ({ schema: 'fleet.job.notes.v1', job: 'RQ-FAKE-7', count: notes.length, notes });
const said = (status: string, extra: Record<string, unknown> = {}) =>
  ({ schema: 'fleet.job.say.v1', job: 'RQ-FAKE-7', status, reason: null, note: null, dryRun: false, duplicate: false, ...extra });
const mount = (open = true, act: 'unlocked' | 'unavailable' = 'unlocked') =>
  renderMobile(<><WorkerNote job="RQ-FAKE-7" open={open} /><MobileGuardSheet /><MobileToasts /></>, { permissions: permissionsFor(act) });

beforeEach(() => { setMutationToken(TOKEN); });
afterEach(() => { clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('sends a note in one tap with no confirmation and says so in plain words', async () => {
  const stub = stubFetch({ [GET]: listing([]), [POST]: said('sent', { note }) });
  mount();
  fireEvent.change(screen.getByLabelText('Your note'), { target: { value: '  skip the phone view ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send note to this job' }));
  expect(await screen.findByText('Note sent to RQ-FAKE-7.')).toBeInTheDocument();
  expect(stub.posts()[0]).toMatchObject({ url: '/api/verse/fleet/runs/notes', body: { id: 'RQ-FAKE-7', text: 'skip the phone view' }, headers: { 'x-ashlr-token': TOKEN } });
  await waitFor(() => expect(screen.getByLabelText('Your note')).toHaveValue(''));
});

it('keeps the words and shows the reason when the job has finished', async () => {
  stubFetch({ [GET]: listing([]), [POST]: said('refused', { reason: 'Job RQ-FAKE-7 has finished, so it cannot read a note.' }) });
  mount();
  fireEvent.change(screen.getByLabelText('Your note'), { target: { value: 'too late' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send note to this job' }));
  expect(await screen.findByText('Job RQ-FAKE-7 has finished, so it cannot read a note.')).toBeInTheDocument();
  expect(screen.getByLabelText('Your note')).toHaveValue('too late');
});

it('lists Notes sent, and offers no box once the job has finished', async () => {
  stubFetch({ [GET]: listing([note]) });
  mount(false);
  expect(await screen.findByText('2026-11-01 00:05 · also update the docs')).toBeInTheDocument();
  expect(screen.getByText('Notes sent')).toBeInTheDocument();
  expect(screen.queryByLabelText('Your note')).not.toBeInTheDocument();
});

it('shows nothing for a finished job with no notes, and no box when actions are unavailable', async () => {
  const stub = stubFetch({ [GET]: listing([]) });
  const view = mount(false);
  await waitFor(() => expect(stub.calls.length).toBeGreaterThan(0));
  expect(screen.queryByText('Tell this job')).not.toBeInTheDocument();
  view.unmount(); evictAll();
  stubFetch({ [GET]: listing([note]) });
  mount(true, 'unavailable');
  expect(await screen.findByText('Notes sent')).toBeInTheDocument();
  expect(screen.queryByLabelText('Your note')).not.toBeInTheDocument();
});
