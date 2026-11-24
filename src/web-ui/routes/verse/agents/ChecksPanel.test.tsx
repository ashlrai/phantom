import { StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AgentChecksDetail } from '../../../../core/verse/agents/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { installFetch, json, TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { ChecksDockPane, ChecksPanel } from './ChecksPanel.js';

function detail(branch = 'feature/first'): AgentChecksDetail {
  return {
    agentId: 'ag_first', sessionId: 'session-first', root: '/fixture/project',
    branch, base: 'master', dirty: 0, ahead: 0, behind: 0, diffstat: null,
    pr: null, ci: 'none', checks: [], comments: [],
    mergeVerdict: { allowed: false, reason: 'No pull request yet.' },
    autoFix: false, autoMerge: false, loopNote: null,
    checkedAt: '2026-11-24T10:00:00Z', unavailable: null,
  };
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('explains a failed read and retries without a mutation', async () => {
  let failed = true;
  const { calls } = installFetch(() => failed ? json({ error: 'internal' }, 500) : json(detail()));
  render(<ChecksPanel cardId="ag_first" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load checks');
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry checks' }));
  await screen.findByText('feature/first');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(calls.map(c => [c.method, c.path])).toEqual([
    ['GET', '/api/verse/agents/ag_first/checks'],
    ['GET', '/api/verse/agents/ag_first/checks?fresh=1'],
  ]);
});

it('keeps the last checks visible with a warning until refresh recovers', async () => {
  let failed = false;
  installFetch(() => failed ? json({ error: 'unavailable' }, 503) : json(detail()));
  render(<ChecksPanel cardId="ag_first" />);
  await screen.findByText('feature/first');
  failed = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Last successful checks are still shown.');
  expect(screen.getByText('feature/first')).toBeInTheDocument();
  failed = false;
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry checks' })));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('offers recovery for an incomplete response', async () => {
  installFetch(() => json({}));
  render(<ChecksPanel cardId="ag_first" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('incomplete response');
  expect(screen.getByRole('button', { name: 'Retry checks' })).toBeEnabled();
});

it('loads correctly under StrictMode effect replay', async () => {
  installFetch(() => json(detail()));
  render(<StrictMode><ChecksPanel cardId="ag_first" /></StrictMode>);
  await screen.findByText('feature/first');
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
});

it('clears previous agent controls immediately and ignores its late refresh', async () => {
  const oldRead = deferred();
  const newRead = deferred();
  const { fetch } = installFetch(call => call.path.includes('ag_second') ? newRead.promise
    : call.path.includes('fresh=1') ? oldRead.promise : json(detail()));
  const view = render(<ChecksPanel cardId="ag_first" />);
  await screen.findByText('feature/first');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  const oldSignal = fetch.mock.calls.at(-1)?.[1]?.signal;
  view.rerender(<ChecksPanel cardId="ag_second" />);
  expect(screen.queryByText('feature/first')).not.toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => newRead.resolve(json(detail('feature/second'))));
  await act(async () => oldRead.resolve(json(detail('feature/stale'))));
  expect(screen.getByText('feature/second')).toBeInTheDocument();
  expect(screen.queryByText('feature/stale')).not.toBeInTheDocument();
});

it('ignores superseded polling responses and cancels the current read when hidden', async () => {
  const poll = deferred();
  const hidden = deferred();
  let reads = 0;
  const { fetch } = installFetch(() => {
    reads += 1;
    if (reads === 2) return poll.promise;
    if (reads === 4) return hidden.promise;
    return json(detail(reads === 3 ? 'feature/newest' : 'feature/first'));
  });
  const view = render(<ChecksPanel cardId="ag_first" />);
  await screen.findByText('feature/first');
  vi.useFakeTimers();
  // Reopen so the polling interval is controlled by the fake clock.
  view.rerender(<ChecksPanel cardId="ag_first" visible={false} />);
  view.rerender(<ChecksPanel cardId="ag_first" />);
  const pollSignal = fetch.mock.calls.at(-1)?.[1]?.signal;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(pollSignal?.aborted).toBe(true);
  expect(screen.getByText('feature/newest')).toBeInTheDocument();
  await act(async () => poll.resolve(json(detail('feature/old-poll'))));
  expect(screen.queryByText('feature/old-poll')).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  const hiddenSignal = fetch.mock.calls.at(-1)?.[1]?.signal;
  view.rerender(<ChecksPanel cardId="ag_first" visible={false} />);
  expect(hiddenSignal?.aborted).toBe(true);
  await act(async () => hidden.resolve(json(detail('feature/hidden'))));
  expect(screen.queryByText('feature/hidden')).not.toBeInTheDocument();
  view.unmount();
});

it('hides old chat checks during agent lookup and keeps the chat-only fallback read-only', async () => {
  const lookup = deferred();
  let lookups = 0;
  const { calls } = installFetch(call => {
    if (call.path === '/api/verse/agents') return ++lookups === 1
      ? json({ cards: [{ id: 'ag_first', sessionId: 'session-first' }] }) : lookup.promise;
    return json(detail(call.path.includes('session-second') ? 'feature/second-chat' : 'feature/first'));
  });
  const host = { addToMessage: vi.fn() };
  const view = render(<ChecksDockPane sessionId="session-first" visible host={host} />);
  await screen.findByText('feature/first');
  view.rerender(<ChecksDockPane sessionId="session-second" visible host={host} />);
  expect(screen.queryByText('feature/first')).not.toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent("Finding this chat's checks");
  await act(async () => lookup.resolve(json({ error: 'unavailable' }, 503)));
  await screen.findByText('feature/second-chat');
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(calls.at(-1)?.path).toBe('/api/verse/agents/chat%3Asession-second/checks');
  expect(calls.every(c => c.method === 'GET')).toBe(true);
});

it('does not apply a completed old-agent mutation to the new pane', async () => {
  const mutation = deferred();
  const onChanged = vi.fn();
  setMutationToken(TEST_TOKEN);
  const { calls } = installFetch(call => call.method === 'POST' ? mutation.promise
    : json(detail(call.path.includes('ag_second') ? 'feature/second' : 'feature/first')));
  const view = render(<ChecksPanel cardId="ag_first" onChanged={onChanged} />);
  await screen.findByText('feature/first');
  fireEvent.click(screen.getByRole('switch', { name: 'Auto-fix CI' }));
  expect(calls.at(-1)?.path).toBe('/api/verse/agents/ag_first/settings');
  view.rerender(<ChecksPanel cardId="ag_second" onChanged={onChanged} />);
  await screen.findByText('feature/second');
  await act(async () => mutation.resolve(json({ agent: {} })));
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('switch', { name: 'Auto-fix CI' })).toBeEnabled();
  expect(calls.filter(c => c.path.includes('fresh=1'))).toEqual([]);
});
