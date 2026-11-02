import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { LaneTargets } from './LaneTargets.js';

const row = { lane: 'codex', target: 1, floor: 0, ceiling: 2, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const healthy = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [row, { ...row, lane: 'claude', target: 2, held: true, heldReason: 'budget' }] };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const token = 'a'.repeat(64);
beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows bounds and held reasons, and disables changes without a token', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ ...healthy, lanes: [{ ...row, target: 0 }, healthy.lanes[1]] })));
  render(<LaneTargets />);
  expect(await screen.findByText('0 ≤ 0 ≤ 2')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Lower codex target to -1' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Raise codex target to 1' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Raise claude target to 3' })).toBeDisabled();
  expect(screen.getByText('Held')).toHaveAttribute('title', 'budget');
  expect(screen.getByText('held: budget')).toBeInTheDocument();
});

it('posts a token-authorized step, disables all rows during the post, and refreshes both queries', async () => {
  setMutationToken(token);
  let finish!: (response: Response) => void;
  const updated = { ...healthy, lanes: [{ ...row, target: 2 }, healthy.lanes[1]] };
  let current = healthy;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(json(url.endsWith('/control/lanes') ? current : {}));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<LaneTargets />);
  fireEvent.click(await screen.findByRole('button', { name: 'Raise codex target to 2' }));
  expect(screen.getByRole('button', { name: 'Lower claude target to 1' })).toBeDisabled();
  const request = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!;
  expect(request.headers).toMatchObject({ 'x-ashlr-token': token });
  expect(JSON.parse(String(request.body))).toEqual({ lane: 'codex', target: 2 });
  current = updated;
  await act(async () => { finish(json(updated)); });
  expect(within(screen.getByText('codex').parentElement!).getByText('0 ≤ 2 ≤ 2')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Raise codex target to 3' })).toBeDisabled();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/fleet/runs'))).toBe(true);
});

it.each([[409, { code: 'busy' }, 'Another fleet control action is running, try again in a moment.'], [422, { code: 'out-of-range', error: 'The target is outside the permitted range.' }, 'The target is outside the permitted range.']])('shows a %i refusal under the affected row', async (status, body, message) => {
  setMutationToken(token);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? json(body, status) : json(healthy)));
  render(<LaneTargets />);
  fireEvent.click(await screen.findByRole('button', { name: 'Raise codex target to 2' }));
  const error = await screen.findByRole('status');
  expect(error).toHaveTextContent(message);
  expect(within(error.parentElement!).getByText('codex')).toBeInTheDocument();
});

it('shows not-landed copy and stops polling after a 404', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fetcher = vi.fn(async () => json({}, 404));
  vi.stubGlobal('fetch', fetcher);
  render(<LaneTargets />);
  expect(await screen.findByText('Lane targets are not available in this build yet.')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('requires a second click within five seconds to lower to zero', async () => {
  setMutationToken(token);
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? json(healthy) : json(healthy));
  vi.stubGlobal('fetch', fetcher);
  render(<LaneTargets />);
  const lower = await screen.findByRole('button', { name: 'Lower codex target to 0' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fireEvent.click(lower);
  expect(screen.getByRole('button', { name: 'Confirm 0 for codex' })).toHaveTextContent('Confirm 0');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  fireEvent.click(screen.getByRole('button', { name: 'Lower codex target to 0' }));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm 0 for codex' })); });
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!;
  expect(JSON.parse(String(post.body))).toEqual({ lane: 'codex', target: 0 });
});

it('polls only while visible', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fetcher = vi.fn(async () => json(healthy));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<SectionVisibilityProvider visible><LaneTargets /></SectionVisibilityProvider>);
  await screen.findByText('0 ≤ 1 ≤ 2');
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<SectionVisibilityProvider visible={false}><LaneTargets /></SectionVisibilityProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
