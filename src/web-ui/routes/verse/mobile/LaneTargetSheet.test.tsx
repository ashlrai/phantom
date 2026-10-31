import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { resetGuard } from '../shell/guard-store.js';
import { LaneTargetSheet } from './LaneTargetSheet.js';
import { MobileGuardSheet } from './MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';
import { json, renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

const row = { lane: 'claude', running: 2, queued: 1, target: 2, floor: 1, ceiling: 3, held: false, heldReason: null, writable: true };
const response = { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [{ ...row, heldUntil: null, lastChange: null, changedBy: null }] };
function mount(overrides = {}, onDone = vi.fn()) {
  renderMobile(<><LaneTargetSheet row={{ ...row, ...overrides }} open onClose={vi.fn()} onDone={onDone} /><MobileGuardSheet /><MobileToasts /></>);
  return onDone;
}
beforeEach(() => setMutationToken(TOKEN));
afterEach(() => { clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest(); vi.unstubAllGlobals(); });
it('bounds the stepper and clamps numeric input on blur', () => {
  mount();
  fireEvent.click(screen.getByLabelText('Decrease target'));
  expect(screen.getByLabelText('Decrease target')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Worker target'), { target: { value: '99' } });
  fireEvent.blur(screen.getByLabelText('Worker target'));
  expect(screen.getByLabelText('Worker target')).toHaveValue(3);
  expect(screen.getByLabelText('Increase target')).toBeDisabled();
});
it('disables held lanes and explains why', () => {
  mount({ held: true, heldReason: 'HOLD file', writable: false });
  expect(screen.getByText("Held: HOLD file. Targets can't change until it clears.")).toBeInTheDocument();
  expect(screen.getByText('Set target', { selector: 'button' })).toBeDisabled();
});
it('explains a missing route', () => {
  mount({ writable: false });
  expect(screen.getByText('Lane targets are not in this build. Update Phantom on your Mac.')).toBeInTheDocument();
});
async function confirm() {
  fireEvent.click(screen.getByLabelText('Increase target'));
  fireEvent.click(screen.getByText('Set target', { selector: 'button' }));
  const guard = (await screen.findByText('Set claude target to 3?')).closest<HTMLElement>('[role="alertdialog"]');
  expect(guard).not.toBeNull();
  return within(guard!).getByText('Set target', { selector: 'button' });
}
it('posts only after confirmation with the mutation token and calls onDone', async () => {
  const stub = stubFetch({ 'POST /api/verse/fleet/control/lanes': response });
  const done = mount();
  const button = await confirm();
  expect(stub.posts()).toHaveLength(0);
  fireEvent.click(button);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(stub.posts()[0]).toMatchObject({ url: '/api/verse/fleet/control/lanes', body: { lane: 'claude', target: 3 } });
  expect(stub.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
  expect(document.body).not.toHaveTextContent(TOKEN);
});
it('toasts a busy response without refreshing or changing the shown target', async () => {
  stubFetch({ 'POST /api/verse/fleet/control/lanes': () => json({ code: 'busy', error: 'Another control action is running.' }, 409) });
  const done = mount();
  fireEvent.click(await confirm());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Another control action is running.'));
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('Running 2 · Target 2 · Queued 1')).toBeInTheDocument();
});
