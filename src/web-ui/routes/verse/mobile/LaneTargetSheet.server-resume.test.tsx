import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { LANE_PAUSE_KEY } from '../fleet-lanes/lane-pause-model.js';
import { resetGuard } from '../shell/guard-store.js';
import { LaneTargetSheet } from './LaneTargetSheet.js';
import { MobileGuardSheet } from './MobileGuardSheet.js';
import { writePauseRecord } from './lane-target-model.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';
import { renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

// A lane paused on another device: this phone has no local record, so the
// resume target comes from the server's pausedFrom, never the floor.
const row = { lane: 'codex-personal', target: 0, floor: 0, ceiling: 32, writable: true,
  running: 0, queued: 3, held: false, heldReason: null, pausedFrom: 6 };
function mount(overrides = {}) {
  const done = vi.fn();
  const close = vi.fn();
  return { ...renderMobile(<><LaneTargetSheet row={{ ...row, ...overrides }} open onClose={close} onDone={done} />
    <MobileGuardSheet /><MobileToasts /></>), done, close };
}
async function confirmResume() {
  const dialog = await screen.findByRole('alertdialog', { name: 'Resume codex-personal?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Resume lane' }));
}
beforeEach(() => { localStorage.removeItem(LANE_PAUSE_KEY); setMutationToken(TOKEN); });
afterEach(() => {
  clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.removeItem(LANE_PAUSE_KEY);
});
it('shows the server-remembered target and resumes to it when this device never saw the pause', async () => {
  const stub = stubFetch({ 'POST /api/verse/fleet/control/lanes': { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] } });
  const view = mount();
  expect(screen.getByText('Paused · was 6')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume lane · back to 6' }));
  expect(await screen.findByText('Restore the codex-personal target to 6. Your Mac will launch workers to match.')).toBeInTheDocument();
  await confirmResume();
  await waitFor(() => expect(view.done).toHaveBeenCalledOnce());
  expect(view.close).toHaveBeenCalledOnce();
  expect(stub.posts()[0]).toMatchObject({ url: '/api/verse/fleet/control/lanes',
    body: { lane: row.lane, target: 6 }, headers: { 'x-ashlr-token': TOKEN } });
});
it('prefers this device\'s record over the server memory', async () => {
  writePauseRecord({ 'codex-personal': 4 });
  const stub = stubFetch({ 'POST /api/verse/fleet/control/lanes': { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] } });
  const view = mount();
  expect(screen.getByText('Paused · was 4')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume lane · back to 4' }));
  await confirmResume();
  await waitFor(() => expect(view.done).toHaveBeenCalledOnce());
  expect(stub.posts()[0]).toMatchObject({ body: { lane: row.lane, target: 4 } });
});
