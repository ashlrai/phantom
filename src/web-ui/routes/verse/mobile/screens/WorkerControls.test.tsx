import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { WorkerControls } from './WorkerControls.js';

const PATH = 'POST /api/verse/fleet/runs/control';
const receipt = (action: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ schema: 'fleet.job.control.v1', action, job: 'RQ-FAKE-7', lane: null, status, reason: null, requestId: 'jc-fake', at: '2026-11-01T00:00:00Z', dryRun: false, duplicate: false, ...extra });
const mount = (act: 'unlocked' | 'unavailable' = 'unlocked') => renderMobile(<><WorkerControls job="RQ-FAKE-7" lane="claude" /><MobileGuardSheet /><MobileToasts /></>,
  { permissions: permissionsFor(act) });

beforeEach(() => { setMutationToken(TOKEN); });
afterEach(() => { clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('pauses in one tap with no confirmation and says so in plain words', async () => {
  const stub = stubFetch({ [PATH]: receipt('pause', 'requested') });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Pause this job' }));
  expect(await screen.findByText('Pause requested for RQ-FAKE-7.')).toBeInTheDocument();
  expect(stub.posts()[0]).toMatchObject({ url: '/api/verse/fleet/runs/control', body: { id: 'RQ-FAKE-7', action: 'pause' }, headers: { 'x-ashlr-token': TOKEN } });
});

it('resumes in one tap', async () => {
  const stub = stubFetch({ [PATH]: receipt('resume', 'requested') });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Resume this job' }));
  expect(await screen.findByText('Resume requested for RQ-FAKE-7.')).toBeInTheDocument();
  expect(stub.posts()[0]?.body).toEqual({ id: 'RQ-FAKE-7', action: 'resume' });
});

it('stop asks once and sends nothing until confirmed', async () => {
  const stub = stubFetch({ [PATH]: receipt('stop', 'applied') });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Stop this job' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Stop RQ-FAKE-7?' });
  expect(stub.posts()).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, stop' }));
  await waitFor(() => expect(stub.posts()).toHaveLength(1));
  expect(stub.posts()[0]?.body).toEqual({ id: 'RQ-FAKE-7', action: 'stop' });
  expect(await screen.findByText('Stopped RQ-FAKE-7.')).toBeInTheDocument();
});

it('moves to a lane picked from the list, skipping held and full lanes', async () => {
  const lane = (name: string, extra: Record<string, unknown> = {}) => ({ lane: name, target: 2, running: 0, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null, ...extra });
  const runs = (lanes: unknown[]) => ({
    v: 1, generatedAt: '2026-11-01T00:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes,
    workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
    events: [], codexPersonal: null, inbox: [], drop: null,
  });
  const stub = stubFetch({
    'GET /api/verse/fleet/runs': runs([lane('claude'), lane('devin', { held: true }), lane('zai', { running: 2 }), lane('grok')]),
    [PATH]: receipt('move', 'requested', { lane: 'grok' }),
  });
  mount();
  const select = screen.getByRole('combobox', { name: 'Move this job to another lane' });
  fireEvent.focus(select);
  await waitFor(() => expect(within(select).getByRole('option', { name: 'grok' })).toBeInTheDocument());
  expect(within(select).queryByRole('option', { name: 'claude' })).not.toBeInTheDocument();
  expect(within(select).getByRole('option', { name: 'devin (held)' })).toBeDisabled();
  expect(within(select).getByRole('option', { name: 'zai (full)' })).toBeDisabled();
  fireEvent.change(select, { target: { value: 'grok' } });
  expect(await screen.findByText('Move to grok requested for RQ-FAKE-7.')).toBeInTheDocument();
  expect(stub.posts()[0]?.body).toEqual({ id: 'RQ-FAKE-7', action: 'move', lane: 'grok' });
});

it('shows the plain refusal and the unknown-job message as a failure', async () => {
  stubFetch({ [PATH]: receipt('resume', 'refused', { reason: 'Job is not paused.' }) });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Resume this job' }));
  expect(await screen.findByText('Job is not paused.')).toBeInTheDocument();
});

it('hides every control on a device that can only read', () => {
  mount('unavailable');
  expect(screen.queryByRole('button', { name: 'Pause this job' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
