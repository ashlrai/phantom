import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { AllowedAppsCard } from './AllowedAppsCard.js';

const fixture = { ok: true, action: 'list', connected: true, logged: true, apps: [
  { name: 'Cursor', bundleId: 'com.example.cursor', running: true, frontmost: false, mode: 'direct', actions: ['status', 'quit'] },
  { name: 'Messages', bundleId: null, running: null, frontmost: null, mode: 'direct', actions: ['status'] },
  { name: 'Phantom', bundleId: 'ai.ashlr.desktop', running: true, frontmost: true, mode: 'request', actions: ['focus', 'quit'] },
] };
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
function serve(body: unknown = fixture, status = 200) {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ action: 'quit', app: 'Phantom', outcome: 'needs-you', detail: 'Sent to needs-you.' }, { status: 202 })
    : Response.json(body, { status }));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
it('renders policy-limited actions and unknown state without suggesting prohibited actions', async () => {
  serve(); render(<AllowedAppsCard visible />);
  expect(await screen.findByText('Cursor: running')).toBeInTheDocument();
  expect(screen.getByText('Messages: unknown')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'quit Messages' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'quit Phantom' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Request quit Phantom' })).toBeInTheDocument();
});
it('sends the typed request with the existing mutation token and displays needs-you', async () => {
  const fetcher = serve(); render(<AllowedAppsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Request quit Phantom' }));
  expect(await screen.findByText('Phantom: Sent to needs-you.')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith('/api/verse/apps/control', expect.objectContaining({ method: 'POST',
    body: JSON.stringify({ app: 'Phantom', action: 'quit', request: true }), headers: expect.objectContaining({ 'x-ashlr-token': 'a'.repeat(64) }) }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2));
});
it('requires unlocked controls and posts nothing without them', async () => {
  const fetcher = serve(); clearMutationToken(); render(<AllowedAppsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'quit Cursor' }));
  expect(screen.getByText('Unlock controls to manage apps.')).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('does not fetch or act while hidden', () => {
  const fetcher = serve(); render(<AllowedAppsCard visible={false} />);
  expect(fetcher).not.toHaveBeenCalled();
});
it('renders failed reads without active controls', async () => {
  serve({}, 503); render(<AllowedAppsCard visible />);
  expect(await screen.findByText('Allowed apps are unavailable. Controls are disabled.')).toBeInTheDocument();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
it('makes the empty allowlist visible', async () => {
  serve({ ...fixture, apps: [] }); render(<AllowedAppsCard visible />);
  expect(await screen.findByText(/No apps allowed/)).toBeInTheDocument();
});
