import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from './Composer.js';
import { CLAUDE_SEAT } from './fixtures.test-support.js';
import { clearComposerMemory } from './chat/composer-state.js';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { refetchQuery } from '../../data/cache.js';
import { opsRunsQuery } from './ops/ops-runs-queries.js';
import { openDockPane } from './dock/dock-store.js';
import { setVerseSection } from './verse-ui-store.js';
import { setFocusMode } from './shell/focus-mode.js';
import { ApiError, type apiPost } from '../../data/client.js';
import { decidePlannerWake, getLastPlannerWakeAt, wakePlannerForOrder } from './composer/planner-wake.js';

vi.mock('../../data/cache.js', async (original) => ({
  ...await original<typeof import('../../data/cache.js')>(),
  refetchQuery: vi.fn(async () => {}),
}));
vi.mock('./dock/dock-store.js', async (original) => ({
  ...await original<typeof import('./dock/dock-store.js')>(), openDockPane: vi.fn(),
}));
vi.mock('./verse-ui-store.js', async (original) => ({
  ...await original<typeof import('./verse-ui-store.js')>(), setVerseSection: vi.fn(),
}));
vi.mock('./shell/focus-mode.js', async (original) => ({
  ...await original<typeof import('./shell/focus-mode.js')>(), setFocusMode: vi.fn(),
}));

let clock = 1_900_000_000_000;
beforeEach(() => {
  clock += 1_000_000;
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  sessionStorage.clear();
  localStorage.clear();
  clearComposerMemory();
  setMutationToken('fake-fleet-test-token');
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/fleet/runs/inbox')) return { ok: true, json: async () => ({ at: '2026-10-31 00:13' }) } as Response;
    if (String(url).endsWith('/planner/run')) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return Response.json({ seats: [] });
  }));
});
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear(); });

async function sendToFleet() {
  const onSend = vi.fn();
  render(<Composer seats={[CLAUDE_SEAT]} seat={{ seatId: CLAUDE_SEAT.id, model: 'claude-opus-5' }}
    engine="claude" running={false} disabled={false} locked={false}
    onSend={onSend} onStop={vi.fn()} onSeatChange={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '/fleet Please prioritize tests' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send message' })); });
  return onSend;
}

it('confirms delivery, refreshes runs once, and reveals the Inbox in chat', async () => {
  vi.useFakeTimers();
  const onSend = await sendToFleet();
  expect(screen.getByText("Sent to the leaders' inbox · 00:13 · open Inbox to confirm")).toBeInTheDocument();
  const refresh = vi.spyOn(opsRunsQuery, 'fetch').mockResolvedValue(null);
  try {
    expect(refetchQuery).toHaveBeenCalledTimes(1);
    expect(refetchQuery).toHaveBeenCalledWith(opsRunsQuery.key, expect.any(Function), true);
    const fetchRuns = vi.mocked(refetchQuery).mock.calls[0]![1];
    await fetchRuns();
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally { refresh.mockRestore(); }
  fireEvent.click(screen.getByRole('button', { name: 'Open inbox' }));
  expect(setVerseSection).toHaveBeenCalledWith('chat');
  expect(setFocusMode).toHaveBeenCalledWith(false);
  expect(openDockPane).toHaveBeenCalledWith('fleet-inbox');
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  act(() => { vi.advanceTimersByTime(8000); });
  expect(screen.queryByRole('button', { name: 'Open inbox' })).not.toBeInTheDocument();
});

it('keeps a failed post sticky without an inbox action or refresh', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) =>
    String(url).endsWith('/fleet/runs/inbox')
      ? Response.json({ error: 'Fleet inbox write failed' }, { status: 500 })
      : Response.json({ seats: [] })));
  await sendToFleet();
  expect(await screen.findByRole('alert')).toHaveTextContent('Fleet inbox write failed');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Open inbox' })).not.toBeInTheDocument();
  expect(refetchQuery).not.toHaveBeenCalled();
  vi.useFakeTimers();
  act(() => { vi.advanceTimersByTime(8001); });
  expect(screen.getByRole('alert')).toHaveTextContent('Fleet inbox write failed');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('/fleet Please prioritize tests');
});

it('decides whether accepted and duplicate orders should wake the planner', () => {
  expect(decidePlannerWake({ outcome: 'duplicate', lastWakeAtMs: null, nowMs: 100 })).toBe('skip-duplicate');
  expect(decidePlannerWake({ outcome: 'accepted', lastWakeAtMs: null, nowMs: 100 })).toBe('wake');
  expect(decidePlannerWake({ outcome: 'accepted', lastWakeAtMs: 100, nowMs: 600_099 })).toBe('skip-recent');
  expect(decidePlannerWake({ outcome: 'accepted', lastWakeAtMs: 100, nowMs: 600_100 })).toBe('wake');
  expect(decidePlannerWake({ outcome: 'accepted', lastWakeAtMs: 100, nowMs: 102, minGapMs: 2 })).toBe('wake');
});

it('posts a bounded, sanitized reason and mirrors its wake time in session storage', async () => {
  const post = vi.fn().mockResolvedValue({ v: 1, outcome: 'ran', exitCode: 0, provider: 'local' });
  const result = await wakePlannerForOrder(`hello\n${'x'.repeat(80)}`, { post: post as typeof apiPost, now: () => clock });
  expect(post).toHaveBeenCalledWith('/api/verse/leader/planner/run', { reason: `inbox order: hello${'x'.repeat(55)}` }, 'fake-fleet-test-token');
  expect(result).toEqual({ kind: 'ran', text: 'Planner pass ran on local for your order' });
  expect(sessionStorage.getItem('verse.planner.lastWakeAt')).toBe(String(clock));
  sessionStorage.setItem('verse.planner.lastWakeAt', String(clock + 1));
  expect(getLastPlannerWakeAt()).toBe(clock + 1);
});

it('maps planner responses and refusals to actionable outcomes', async () => {
  const post = vi.fn();
  const deps = { post: post as typeof apiPost };
  post.mockResolvedValueOnce({ v: 1, outcome: 'started' });
  expect((await wakePlannerForOrder('order', deps)).kind).toBe('started');
  post.mockResolvedValueOnce({ v: 1, outcome: 'failed', exitCode: 1, provider: 'local' });
  expect(await wakePlannerForOrder('order', deps)).toEqual({ kind: 'failed', text: 'Planner pass ran on local: failed (exit 1)' });
  post.mockResolvedValueOnce({ v: 1, outcome: 'plan-failed', planError: 'Planner unavailable' });
  expect(await wakePlannerForOrder('order', deps)).toEqual({ kind: 'failed', text: 'Planner unavailable' });
  post.mockResolvedValueOnce({});
  expect((await wakePlannerForOrder('order', deps)).kind).toBe('failed');
  for (const [status, detail, kind, text] of [
    [409, 'pass-in-flight', 'in-flight', 'A planner pass is already running; your order is in its inbox'],
    [409, 'no-slate', 'no-slate', 'Order saved. The planner has no logins declared: Settings, Planner logins'],
    [409, 'no-prompt-declared', 'no-slate', 'Order saved. The planner has no logins declared: Settings, Planner logins'],
    [401, null, 'locked', 'Order saved. Unlock controls to wake the planner.'],
    [403, null, 'locked', 'Order saved. Unlock controls to wake the planner.'],
    [404, null, 'unavailable', ''],
    [500, 'Planner failed', 'failed', 'Planner failed'],
  ] as const) {
    post.mockRejectedValueOnce(new ApiError('failure', status, '/', detail));
    expect(await wakePlannerForOrder('order', deps)).toEqual({ kind, text });
  }
  expect((await wakePlannerForOrder('order', { getToken: () => null, post: post as typeof apiPost })).kind).toBe('locked');
});

it('does not issue a second request while a wake is still in flight', async () => {
  let finish!: (value: unknown) => void;
  const post = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const first = wakePlannerForOrder('first', { post: post as typeof apiPost });
  expect((await wakePlannerForOrder('second', { post: post as typeof apiPost })).kind).toBe('in-flight');
  expect(post).toHaveBeenCalledTimes(1);
  finish({ v: 1, outcome: 'ran', exitCode: 0, provider: 'local' });
  await first;
});

it('wakes once after acceptance, without blocking the draft or a second order', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn((url: RequestInfo | URL) => {
    if (String(url).endsWith('/fleet/runs/inbox')) return Promise.resolve(Response.json({ at: '2026-10-31 00:13' }));
    if (String(url).endsWith('/planner/run')) return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(Response.json({ seats: [] }));
  });
  vi.stubGlobal('fetch', fetcher);
  await sendToFleet();
  expect(screen.getByText(/planner waking/)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  const box = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(box, { target: { value: '/fleet Another order' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(box).toHaveValue(''));
  const posts = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/planner/run'));
  expect(posts).toHaveLength(1);
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/planner/run'));
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ reason: 'inbox order: Please prioritize tests' });
  await act(async () => finish(Response.json({ v: 1, outcome: 'ran', exitCode: 0, provider: 'local' })));
  expect(await screen.findByText('Planner pass ran on local for your order')).toBeInTheDocument();
});

it('does not wake for duplicate orders', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/fleet/runs/inbox')
    ? Response.json({ at: '2026-10-31 00:13', duplicate: true }) : Response.json({ seats: [] }));
  vi.stubGlobal('fetch', fetcher);
  await sendToFleet();
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/planner/run'))).toBe(false);
  expect(screen.getByText(/Already in the inbox/)).toBeInTheDocument();
});

it('shows an in-flight conflict without an error state', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/fleet/runs/inbox')) return Response.json({ at: '2026-10-31 00:13' });
    if (String(url).endsWith('/planner/run')) return Response.json({ error: 'pass-in-flight' }, { status: 409 });
    return Response.json({ seats: [] });
  }));
  await sendToFleet();
  expect(await screen.findByText('A planner pass is already running; your order is in its inbox')).toHaveAttribute('role', 'status');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('restores the wake time after a module reload', async () => {
  sessionStorage.setItem('verse.planner.lastWakeAt', String(clock));
  vi.resetModules();
  const fresh = await import('./composer/planner-wake.js');
  expect(fresh.getLastPlannerWakeAt()).toBe(clock);
  expect(fresh.decidePlannerWake({ outcome: 'accepted', lastWakeAtMs: fresh.getLastPlannerWakeAt(), nowMs: clock + 1 })).toBe('skip-recent');
});

it('does not wake again within ten minutes after a completed pass', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/fleet/runs/inbox')) return Response.json({ at: '2026-10-31 00:13' });
    if (String(url).endsWith('/planner/run')) return Response.json({ v: 1, outcome: 'ran', exitCode: 0, provider: 'local' });
    return Response.json({ seats: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  await sendToFleet();
  await screen.findByText('Planner pass ran on local for your order');
  const box = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(box, { target: { value: '/fleet Another order' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(box).toHaveValue(''));
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/planner/run'))).toHaveLength(1);
});
