import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { resetGuard } from '../shell/guard-store.js';
import { releaseLaneHold } from './fleet-actions.js';
import { LaneTargetSheet } from './LaneTargetSheet.js';
import { MobileGuardSheet } from './MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';
import { json, renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';

const heldUntil = new Date(Date.now() + 2 * 3_600_000).toISOString();
const row = {
  lane: 'codex-personal', running: 0, queued: 3, target: 0, floor: 0, ceiling: 8,
  held: true, heldReason: 'autobackoff codex_usage_limit job=j-fake', writable: false, pausedFrom: null,
  heldUntil, changedBy: 'autobackoff',
};
const lanesResponse = { v: 1, generatedAt: '', sourceState: 'healthy', lanes: [{ ...row, held: false, heldReason: null, heldUntil: null, lastChange: null }] };

function mount(overrides = {}, onDone = vi.fn()) {
  renderMobile(<><LaneTargetSheet row={{ ...row, ...overrides }} open onClose={vi.fn()} onDone={onDone} /><MobileGuardSheet /><MobileToasts /></>);
  return onDone;
}
beforeEach(() => setMutationToken(TOKEN));
afterEach(() => { clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest(); vi.unstubAllGlobals(); });

it('shows the reason, countdown and attribution for an autobackoff hold', () => {
  mount();
  expect(screen.getByText(/Held: autobackoff codex_usage_limit job=j-fake · clears in 2 h · placed by autobackoff/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Release hold' })).toBeEnabled();
  expect(screen.queryByText('Placed by hand; release it from the Mac.')).not.toBeInTheDocument();
});

it('shows neither countdown nor release for a hold a person placed', () => {
  mount({ heldReason: 'usage cap', heldUntil: null, changedBy: 'Mason t1221u' });
  expect(screen.getByText(/placed by Mason t1221u/)).toBeInTheDocument();
  expect(screen.getByText('Placed by hand; release it from the Mac.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Release hold' })).not.toBeInTheDocument();
});

it('posts exactly { lane, action: release } with the mutation token, then refetches lanes', async () => {
  const stub = stubFetch({ 'POST /api/verse/fleet/control/holds': { ok: true }, 'GET /api/verse/fleet/control/lanes': lanesResponse });
  const done = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Release hold' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(stub.posts()).toHaveLength(1);
  expect(stub.posts()[0]!.url).toBe('/api/verse/fleet/control/holds');
  expect(stub.posts()[0]!.body).toEqual({ lane: 'codex-personal', action: 'release' });
  expect(stub.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
  await waitFor(() => expect(stub.calls.some((c) => c.method === 'GET' && c.url === '/api/verse/fleet/control/lanes')).toBe(true));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('codex-personal hold released.'));
});

it('includes the reason when given', async () => {
  const stub = stubFetch({ 'POST /api/verse/fleet/control/holds': { ok: true } });
  await releaseLaneHold('claude', 'reset detected');
  expect(stub.posts()[0]!.body).toEqual({ lane: 'claude', action: 'release', reason: 'reset detected' });
});

it('toasts the refusal when the Mac rejects the release', async () => {
  stubFetch({ 'POST /api/verse/fleet/control/holds': () => json({ code: 'manual-hold', error: 'Lane was held manually' }, 422) });
  const done = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Release hold' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Lane was held manually'));
  expect(done).not.toHaveBeenCalled();
});
