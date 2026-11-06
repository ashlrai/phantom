import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { UpdateStatusRow } from './UpdateStatusRow.js';

const facts = { v: 1, sourceState: 'healthy', installedVersion: '1.0.0', headSha: 'abcdef123456', headAt: null, originSha: null, branch: 'master', behind: 2, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: 120, canFastForward: true };
const success = () => new Response(JSON.stringify({ ok: true, action: 'fetch', fetchedAt: '2026-01-01T00:00:00Z' }));
beforeEach(() => { sessionStorage.clear(); evictAll(); clearMutationToken(); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup(post: () => Promise<Response> = async () => success()) {
  const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? post() : Promise.resolve(new Response(JSON.stringify(facts))));
  vi.stubGlobal('fetch', fetcher);
  render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
  return fetcher;
}
it('fetches once on return to a visible document, then refreshes status', async () => {
  setMutationToken('test-only');
  let finish!: (response: Response) => void;
  const fetcher = setup(() => new Promise((resolve) => { finish = resolve; }));
  await screen.findByText(/2 commits behind/);
  expect(screen.getByText(/not checked this session/)).toBeInTheDocument();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  fireEvent.focus(window);
  const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.[1]).toMatchObject({ method: 'POST', body: '{"action":"fetch"}' });
  const beforeCompletion = fetcher.mock.calls.length;
  await act(async () => { finish(success()); });
  await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(beforeCompletion));
  expect(fetcher.mock.calls[beforeCompletion]?.[1]?.method).toBe('GET');
  expect(screen.getByText(/checked \d+s ago/)).toBeInTheDocument();
  fireEvent.focus(window);
  expect(posts()).toHaveLength(1);
});
it('does not post when the status route is missing', async () => {
  setMutationToken('test-only');
  const fetcher = vi.fn(async () => new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
  await screen.findByText(/not in this build yet/);
  fireEvent.focus(window);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not post when locked', async () => {
  const fetcher = setup();
  await screen.findByText(/2 commits behind/);
  fireEvent(document, new Event('visibilitychange'));
  fireEvent.focus(window);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
it('records a manual check so a subsequent focus does not fetch again', async () => {
  setMutationToken('test-only');
  const fetcher = setup();
  await screen.findByText(/2 commits behind/);
  await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
  await screen.findByText(/checked \d+s ago/);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  fireEvent.focus(window);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
