import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { LANE_PAUSE_KEY } from '../fleet-lanes/lane-pause-model.js';
import { resetGuard } from '../shell/guard-store.js';
import { LaneTargetSheet } from './LaneTargetSheet.js';
import { MobileGuardSheet } from './MobileGuardSheet.js';
import { pauseState, readPauseRecord, writePauseRecord } from './lane-target-model.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

const row = { lane: 'codex-personal', target: 24, floor: 0, ceiling: 32, writable: true,
  running: 2, queued: 1, held: false, heldReason: null, pausedFrom: null };
function mount(target = 24, overrides: Parameters<typeof renderMobile>[1] = {}) {
  const done = vi.fn();
  const close = vi.fn();
  return { ...renderMobile(<><LaneTargetSheet row={{ ...row, target }} open onClose={close} onDone={done} />
    <MobileGuardSheet /><MobileToasts /></>, overrides), done, close };
}
async function confirm(action: 'Pause' | 'Resume') {
  const dialog = await screen.findByRole('alertdialog', { name: `${action} codex-personal?` });
  fireEvent.click(within(dialog).getByRole('button', { name: `${action} lane` }));
}
beforeEach(() => { localStorage.removeItem(LANE_PAUSE_KEY); setMutationToken(TOKEN); });
afterEach(() => {
  clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.removeItem(LANE_PAUSE_KEY);
});
it('pauses after confirmation and resumes the remembered target when reopened', async () => {
  const stub = stubFetch({ 'POST /api/verse/fleet/control/lanes': { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] } });
  const first = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Pause lane' }));
  expect(stub.posts()).toHaveLength(0);
  expect(readPauseRecord()).toEqual({});
  expect(screen.getByText('Running workers finish; nothing new starts on it. Target goes to 0; the old target 24 is remembered.')).toBeInTheDocument();
  await confirm('Pause');
  await waitFor(() => expect(first.done).toHaveBeenCalledOnce());
  expect(first.close).toHaveBeenCalledOnce();
  expect(stub.posts()[0]).toMatchObject({ url: '/api/verse/fleet/control/lanes',
    body: { lane: row.lane, target: 0 }, headers: { 'x-ashlr-token': TOKEN } });
  expect(JSON.parse(localStorage.getItem(LANE_PAUSE_KEY)!)).toEqual({ 'codex-personal': 24 });
  first.unmount();
  const second = mount(0);
  expect(screen.getByText('Paused · was 24')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume lane · back to 24' }));
  expect(stub.posts()).toHaveLength(1);
  await confirm('Resume');
  await waitFor(() => expect(second.done).toHaveBeenCalledOnce());
  expect(stub.posts()[1]).toMatchObject({ body: { lane: row.lane, target: 24 } });
  expect(readPauseRecord()).toEqual({});
});
it('asks for confirmation before requesting a missing mutation token', async () => {
  clearMutationToken();
  const stub = stubFetch({ 'POST /api/verse/fleet/control/lanes': { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] } });
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Pause lane' }));
  expect(screen.queryByLabelText('Mutation token')).not.toBeInTheDocument();
  await confirm('Pause');
  fireEvent.change(await screen.findByLabelText('Mutation token'), { target: { value: TOKEN } });
  expect(stub.posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Unlock and pause lane' }));
  await waitFor(() => expect(view.done).toHaveBeenCalledOnce());
  expect(stub.posts()[0]!.body).toEqual({ lane: row.lane, target: 0 });
});
it.each(['absent', 'offline', 'unreachable', 'unwritable'] as const)('disables pause when %s', (condition) => {
  if (condition === 'unwritable') {
    renderMobile(<LaneTargetSheet row={{ ...row, writable: false }} open onClose={vi.fn()} onDone={vi.fn()} />);
  } else {
    mount(24, condition === 'absent' ? { permissions: permissionsFor('unavailable') } : { reachability: condition });
  }
  expect(screen.getByRole('button', { name: 'Pause lane' })).toBeDisabled();
});
it('keeps remembered targets unchanged when the POST fails', async () => {
  writePauseRecord({ other: 8 });
  stubFetch({ 'POST /api/verse/fleet/control/lanes': () => json({ error: 'Busy' }, 409) });
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Pause lane' }));
  await confirm('Pause');
  await screen.findByRole('alert');
  expect(readPauseRecord()).toEqual({ other: 8 });
  expect(view.done).not.toHaveBeenCalled();
});
it('handles unavailable storage and uses the shared resume fallback', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
  expect(readPauseRecord()).toEqual({});
  expect(() => writePauseRecord({ 'codex-personal': 24 })).not.toThrow();
  expect(pauseState({ ...row, target: 0 }, {})).toEqual({ paused: true, label: null, resumeTarget: 1 });
  expect(pauseState(row, { 'codex-personal': 24 }).label).toBeNull();
});
