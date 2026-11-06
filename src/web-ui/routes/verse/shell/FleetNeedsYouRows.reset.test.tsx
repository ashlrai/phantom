import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const fleet = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z', paused: false, memFreePct: 50, diskFreeGb: 80, switches: ['HOLD'], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: 1, publishesLastHour: [], mergesLastHour: { count: 1, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};
const row = { lane: 'lane-a', held: true, heldReason: 'fake reason', heldUntil: null, holdSince: null, heldBy: 'autobackoff',
  usedPct: 10, readingAsOf: null, resetAt: null, state: 'reset-detected', releasable: true, tell: 'Fake reset reading.' };
function setup(options: { failure?: boolean; resetStatus?: number; degraded?: boolean; gate?: Promise<void> } = {}) {
  let released = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/verse/fleet/runs') return Response.json(fleet);
    if (path === '/api/verse/leader/resources/resets') return options.resetStatus
      ? new Response('', { status: options.resetStatus })
      : Response.json({ v: 1, generatedAt: fleet.generatedAt, sourceState: options.degraded ? 'degraded' : 'healthy', rows: released ? [] : [row] });
    if (path === '/api/verse/fleet/control/holds' && init?.method === 'POST') {
      await options.gate;
      if (options.failure) return Response.json({ error: 'Fake conflict; try again.' }, { status: 409 });
      released = true;
      return Response.json({ ok: true });
    }
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetNeedsYouRows split="fleet" nowMs={now} onResult={() => {}} />);
  return fetcher;
}
beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { cleanup(); clearMutationToken(); evictAll(); vi.unstubAllGlobals(); });

it('releases once and refreshes both reads without opening the row', async () => {
  setMutationToken('fake-mutation-token');
  const fetcher = setup();
  const user = userEvent.setup();
  const title = await screen.findByText('lane-a reset; its hold is still on');
  await user.click(within(title.closest('[data-severity]') as HTMLElement).getByRole('button', { name: 'Release lane-a' }));
  expect(await screen.findByText('Released hold for lane-a.')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('lane-a reset; its hold is still on')).not.toBeInTheDocument());
  const calls = fetcher.mock.calls;
  const posts = calls.filter(([path]) => String(path) === '/api/verse/fleet/control/holds');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({ lane: 'lane-a', action: 'release', reason: 'reset detected (Needs-you)' });
  expect(calls.filter(([path]) => String(path) === '/api/verse/fleet/runs').length).toBeGreaterThanOrEqual(2);
  expect(calls.filter(([path]) => String(path) === '/api/verse/leader/resources/resets').length).toBeGreaterThanOrEqual(2);
});
it('shows a conflict inline and retains the row', async () => {
  setMutationToken('fake-mutation-token');
  setup({ failure: true });
  await userEvent.click(await screen.findByRole('button', { name: 'Release lane-a' }));
  expect(await screen.findByText('Fake conflict; try again.')).toBeInTheDocument();
  expect(screen.getByText('lane-a reset; its hold is still on')).toBeInTheDocument();
});
it('disables release while the request is pending', async () => {
  setMutationToken('fake-mutation-token');
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const fetcher = setup({ gate });
  await userEvent.click(await screen.findByRole('button', { name: 'Release lane-a' }));
  expect(screen.getByRole('button', { name: 'Release lane-a' })).toBeDisabled();
  expect(screen.getByText('Releasing…')).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/verse/fleet/control/holds')).toHaveLength(1);
  finish();
  expect(await screen.findByText('Released hold for lane-a.')).toBeInTheDocument();
});
it('disables release without a token and shows the unlock hint', async () => {
  setup();
  expect(await screen.findByRole('button', { name: 'Release lane-a' })).toBeDisabled();
  expect(screen.getByText('Unlock to release')).toBeInTheDocument();
});
it('keeps existing fleet items if reset reads fail or are degraded', async () => {
  setup({ resetStatus: 500 });
  expect(await screen.findByText('Dispatch is paused by HOLD')).toBeInTheDocument();
  cleanup(); evictAll();
  setup({ degraded: true });
  expect(await screen.findByText('Dispatch is paused by HOLD')).toBeInTheDocument();
  expect(await screen.findByText('lane-a reset; its hold is still on')).toBeInTheDocument();
});
