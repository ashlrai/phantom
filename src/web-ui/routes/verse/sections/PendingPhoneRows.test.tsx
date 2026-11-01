import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { PendingPhoneRows } from './PendingPhoneRows.js';

const id = '11111111-1111-1111-1111-111111111111';
const deviceId = '22222222-2222-2222-2222-222222222222';
const phone = { id, label: 'Mason phone', email: 'mason@example.invalid', subject: 'private subject', deviceType: 'phone', credentialId: 'private credential' };
const pending = { v: 1, generatedAt: 'now', gateway: 'running', approvals: [phone] };
const pendingPath = '/api/verse/fleet/control/remote-pending';
const pairedPath = '/api/verse/fleet/control/remote-devices';
const postPath = '/api/verse/fleet/control/remote-pairing';

beforeEach(() => { evictAll(); clearMutationToken(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function mount(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', fetcher);
  return render(<ToastProvider><PendingPhoneRows /></ToastProvider>);
}
function response(url: string) {
  return Response.json(url === pendingPath ? pending : { v: 1, devices: [] });
}

it.each(['approve', 'deny'] as const)('posts %s and refreshes both lists', async action => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ v: 1, result: action === 'approve' ? { approved: true, deviceId } : { denied: true } }) : response(url));
  mount(fetcher as typeof fetch);
  expect(await screen.findByText('Mason phone · mason@example.invalid · phone')).toBeInTheDocument();
  expect(screen.queryByText('private subject')).not.toBeInTheDocument();
  expect(screen.queryByText('private credential')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: action === 'approve' ? 'Approve' : 'Deny' }));
  expect(await screen.findByText(action === 'approve' ? `Approved · device ${deviceId}` : 'Denied')).toBeInTheDocument();
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === pendingPath)).toHaveLength(2));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === pairedPath)).toBe(true));
  const [url, init] = fetcher.mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(url).toBe(postPath);
  expect(JSON.parse(String(init?.body))).toEqual({ action, id });
});

it('disables all decisions during the Mac dialog and shows server errors', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn((url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(response(url)));
  mount(fetcher as typeof fetch);
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  expect(screen.getByText('Confirm on the Mac dialog…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  await act(async () => finish(Response.json({ code: 'failed', error: 'Mac operator confirmation required' }, { status: 502 })));
  expect(await screen.findByText('Mac operator confirmation required')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
});

it('hides when the route is not in this build and gates buttons on the mutation hold', async () => {
  clearMutationToken();
  const fetcher = vi.fn(async () => response(pendingPath));
  const view = mount(fetcher as typeof fetch);
  expect(await screen.findByRole('button', { name: 'Approve' })).toBeDisabled();
  view.unmount(); evictAll();
  const missing = vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 }));
  const empty = mount(missing as typeof fetch);
  await waitFor(() => expect(missing).toHaveBeenCalled());
  await waitFor(() => expect(getQuerySnapshot('verse-remote-pending').data).toEqual({ kind: 'notInBuild' }));
  expect(empty.container).toHaveTextContent('');
  expect(empty.container.querySelector('button')).toBeNull();
});

it('polls every 15 seconds while visible and refreshes on return', async () => {
  const fetcher = vi.fn(async () => response(pendingPath));
  vi.stubGlobal('fetch', fetcher); vi.useFakeTimers();
  const view = (visible: boolean) => <ToastProvider><SectionVisibilityProvider visible={visible}><PendingPhoneRows /></SectionVisibilityProvider></ToastProvider>;
  const rendered = render(view(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rendered.rerender(view(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rendered.rerender(view(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
