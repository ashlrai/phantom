import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { UpdateStatusRow } from './UpdateStatusRow.js';

const facts = { v: 1, sourceState: 'healthy', installedVersion: '1.0.0', headSha: 'abcdef123456', headAt: null, originSha: null, branch: 'master', behind: 2, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: 120, canFastForward: true };
beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });
function setup(post: () => Promise<Response>) {
  const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? post() : Promise.resolve(new Response(JSON.stringify(facts))));
  vi.stubGlobal('fetch', fetcher);
  render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
  return fetcher;
}
it('fetches origin before refreshing the query and shows progress', async () => {
  setMutationToken('test-only');
  let finish!: (response: Response) => void;
  const fetcher = setup(() => new Promise((resolve) => { finish = resolve; }));
  await screen.findByText(/2 commits behind/);
  await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
  expect(screen.getByText(/Checking origin…/)).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { 'x-ashlr-token': 'test-only' }, body: '{"action":"fetch"}' });
  finish(new Response(JSON.stringify({ ok: true, action: 'fetch', fetchedAt: '2026-01-01T00:00:00Z' })));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(fetcher.mock.calls[2]?.[1]?.method).toBe('GET');
});
it('refreshes without posting when locked', async () => {
  const fetcher = setup(() => { throw new Error('unexpected post'); });
  await screen.findByText(/2 commits behind/);
  await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});
it('shows a failure note and clears it after a successful fetch', async () => {
  setMutationToken('test-only');
  let success = false;
  const fetcher = setup(async () => new Response(JSON.stringify(success ? { ok: true, action: 'fetch', fetchedAt: '2026-01-01T00:00:00Z' } : { ok: false })));
  await screen.findByText(/2 commits behind/);
  await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
  expect(await screen.findByText(/fetch failed/)).toBeInTheDocument();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  success = true;
  await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
  expect(screen.queryByText(/fetch failed/)).not.toBeInTheDocument();
});
