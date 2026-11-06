import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { releaseLaneHold, refreshFleetReads } from '../fleet-actions.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { activityResponse, activityState, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { NeedsYouScreen } from './NeedsYouScreen.js';

vi.mock('../fleet-actions.js', () => ({ releaseLaneHold: vi.fn(), refreshFleetReads: vi.fn() }));

const lane = { lane: 'codex-personal', target: 0, floor: 0, ceiling: 8, held: true,
  heldReason: 'usage limit', heldUntil: null, lastChange: null, changedBy: 'autobackoff' };
const response = (lanes: typeof lane[]) => ({ v: 1, generatedAt: '', sourceState: 'healthy', lanes });
const activity = activityState(activityResponse());

beforeEach(() => {
  setMutationToken(TOKEN);
  vi.mocked(releaseLaneHold).mockReset();
  vi.mocked(refreshFleetReads).mockReset();
});

afterEach(() => {
  clearMutationToken();
  resetGuard();
  resetMobileToastsForTest();
  evictAll();
  vi.unstubAllGlobals();
});

it('releases once, refreshes fleet reads, and removes the lane after a fresh holds read', async () => {
  let held = true;
  let finish!: () => void;
  vi.mocked(releaseLaneHold).mockImplementation(() => new Promise<void>((resolve) => {
    finish = () => { held = false; resolve(); };
  }));
  stubFetch({ 'GET /api/verse/fleet/control/holds': () => response(held ? [lane] : []) });
  renderMobile(<><NeedsYouScreen /><MobileToasts /></>, { activity });
  expect(await screen.findByRole('heading', { name: 'Held lanes' })).toBeInTheDocument();
  expect(screen.getByText('codex-personal is held')).toBeInTheDocument();
  expect(screen.getByText('usage limit · no end set')).toBeInTheDocument();
  expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Release: codex-personal' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(releaseLaneHold).toHaveBeenCalledOnce();
  expect(releaseLaneHold).toHaveBeenCalledWith('codex-personal', 'phone');
  expect(button).toBeDisabled();
  finish();
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Held lanes' })).not.toBeInTheDocument());
  expect(refreshFleetReads).toHaveBeenCalledOnce();
  expect(await screen.findByText('codex-personal hold released.')).toBeInTheDocument();
  expect(screen.getByText('All clear')).toBeInTheDocument();
});

it('leaves the existing empty state unchanged when no lanes are held', async () => {
  stubFetch({ 'GET /api/verse/fleet/control/holds': response([{ ...lane, held: false }]) });
  renderMobile(<NeedsYouScreen />, { activity });
  await waitFor(() => expect(screen.getByText('All clear')).toBeInTheDocument());
  expect(screen.queryByRole('heading', { name: 'Held lanes' })).not.toBeInTheDocument();
});

it('shows manual holds as Mac-only and disables release when the phone cannot act', async () => {
  stubFetch({ 'GET /api/verse/fleet/control/holds': response([lane, { ...lane, lane: 'manual', changedBy: 'Mason' }]) });
  renderMobile(<NeedsYouScreen />, { activity, permissions: permissionsFor('unavailable') });
  expect(await screen.findByText('Needs the Mac')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Release: codex-personal' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Release: manual' })).not.toBeInTheDocument();
});

it('reports a release failure and leaves the hold visible for retry', async () => {
  vi.mocked(releaseLaneHold).mockRejectedValue(new Error('Release refused'));
  stubFetch({ 'GET /api/verse/fleet/control/holds': response([lane]) });
  renderMobile(<><NeedsYouScreen /><MobileToasts /></>, { activity });
  await userEvent.click(await screen.findByRole('button', { name: 'Release: codex-personal' }));
  expect(await screen.findByText('Release refused')).toBeInTheDocument();
  expect(screen.getByText('codex-personal is held')).toBeInTheDocument();
  expect(refreshFleetReads).not.toHaveBeenCalled();
});
