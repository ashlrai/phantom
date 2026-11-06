import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll, getQuerySnapshot } from '../../../../data/cache.js';
import { leaderState } from '../../command/fixtures.test-support.js';
import { resetGuard } from '../../shell/guard-store.js';
import { homeRunsQuery } from '../home-runs-query.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { LeaderScreen } from './LeaderScreen.js';

const now = Date.parse('2026-10-31T05:00:00Z');
const order = { at: '2026-10-31 00:15', source: 'email', text: 'Watch the fleet' };
function setup(events: { at: string; kind: string; text: string }[] = [], fail = false) {
  return stubFetch({
    'GET /api/verse/leader/thread': { messages: [] },
    'GET /api/verse/leader/directives': { directives: [], retired: [] },
    'GET /api/verse/leader': leaderState('live'),
    'GET /api/verse/fleet/runs': { v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [], mergesLastHour: { count: null }, codexPersonal: null, inbox: [order], events },
    'POST /api/verse/fleet/runs/inbox': fail ? () => json({ error: 'Inbox is full.' }, 400) : { ok: true, at: '2026-10-31 01:00' },
  });
}
function renderLeader() { return renderMobile(<><LeaderScreen /><MobileGuardSheet /><MobileToasts /></>); }
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); setMutationToken(TOKEN); });
afterEach(() => { clearMutationToken(); evictAll(); resetGuard(); resetMobileToastsForTest(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the unanswered order and posts one follow-up, with an acknowledgement and cooldown', async () => {
  const stub = setup();
  renderLeader();
  const section = await screen.findByRole('region', { name: 'Unanswered orders' });
  expect(within(section).getByText('45 min · Watch the fleet')).toBeInTheDocument();
  expect(within(section).getByText(/1 order has had no leader reaction/)).toBeInTheDocument();
  const button = within(section).getByRole('button', { name: 'Ask again' });
  const timers = vi.spyOn(globalThis, 'setTimeout');
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(stub.posts()).toHaveLength(1));
  expect(stub.posts()[0]).toMatchObject({ body: { text: 'Still unanswered after 45 min: Watch the fleet', source: 'Phantom mobile' } });
  expect(await screen.findByText(/^Landed /)).toBeInTheDocument();
  expect(button).toBeDisabled();
  const cooldown = timers.mock.calls.find((call) => call[1] === 60_000);
  expect(cooldown).toBeDefined();
  act(() => { (cooldown![0] as () => void)(); });
  expect(button).toBeEnabled();
}, 15_000);

it('hides answered orders', async () => {
  setup([{ at: '2026-10-31T00:20:00Z', kind: 'LEADER', text: 'pass' }]);
  renderLeader();
  await waitFor(() => expect(getQuerySnapshot(homeRunsQuery.key).status).toBe('success'));
  expect(screen.queryByRole('region', { name: 'Unanswered orders' })).not.toBeInTheDocument();
});

it('re-enables a failed follow-up and prevents sends while offline or read-only', async () => {
  const stub = setup([], true);
  const view = renderLeader();
  const button = within(await screen.findByRole('region', { name: 'Unanswered orders' })).getByRole('button', { name: 'Ask again' });
  fireEvent.click(button);
  expect(await screen.findByText(/Inbox is full/)).toBeInTheDocument();
  await waitFor(() => expect(button).toBeEnabled());
  expect(stub.posts()).toHaveLength(1);
  view.unmount();
  renderMobile(<LeaderScreen />, { reachability: 'offline' });
  expect(within(await screen.findByRole('region', { name: 'Unanswered orders' })).getByRole('button', { name: 'Ask again' })).toBeDisabled();
});

it('does not offer a write to a read-only phone', async () => {
  setup();
  renderMobile(<LeaderScreen />, { permissions: permissionsFor('unavailable') });
  const section = await screen.findByRole('region', { name: 'Unanswered orders' });
  expect(within(section).queryByRole('button', { name: 'Ask again' })).not.toBeInTheDocument();
});
