import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MacAppsCard } from './MacAppsCard.js';

const row = (id: string, name: string, extra: Record<string, unknown>) => ({
  id, name, role: 'Assistant', installed: true, running: true, frontmost: false, memoryMb: 150, path: `/Applications/${name}.app`,
  bundleId: null, quit: id === 'safari' ? 'allowed' : 'protected', action: 'focus', reason: null, ...extra,
});
const fixture = { schema: 'phm.apps/1', probe: 'ok', reason: null, apps: [
  row('phantom', 'Phantom', { frontmost: true, action: null }),
  row('claude', 'Claude', { memoryMb: 2048 }),
  row('codex', 'Codex', { installed: false, running: false, frontmost: false, memoryMb: null, action: null }),
  row('chatgpt', 'ChatGPT', { running: false, memoryMb: null, action: 'open' }),
  row('grok', 'Grok', { installed: null, running: null, frontmost: null, memoryMb: null, action: null, reason: 'ps failed' }),
] };

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
function serve(body: unknown = fixture, status = 200) {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ action: 'focus', app: 'claude', outcome: 'done', detail: 'raised Claude.' })
    : Response.json(body, { status }));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}

it('renders one row per app with plain state and at most one obvious action', async () => {
  serve(); render(<MacAppsCard visible />);
  expect(await screen.findByText('Running · 2.0 GB')).toBeInTheDocument();
  expect(screen.getByText('In front · 150 MB')).toBeInTheDocument();
  expect(screen.getByText('Not installed')).toBeInTheDocument();
  expect(screen.getByText('Not running')).toBeInTheDocument();
  expect(screen.getByText('Unknown')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
  // Phantom, a missing app and an unknown app get no button; nothing offers quit.
  expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Bring to front Claude', 'Open ChatGPT']);
  expect(screen.queryByRole('button', { name: /quit/i })).not.toBeInTheDocument();
});

it('acts through the shared control API with the app id and the mutation token', async () => {
  const fetcher = serve(); render(<MacAppsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Bring to front Claude' }));
  expect(await screen.findByText('Claude: raised Claude.')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith('/api/verse/apps/control', expect.objectContaining({ method: 'POST',
    body: JSON.stringify({ app: 'claude', action: 'focus' }), headers: expect.objectContaining({ 'x-ashlr-token': 'a'.repeat(64) }) }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2));
});

it('posts nothing while controls are locked', async () => {
  const fetcher = serve(); clearMutationToken(); render(<MacAppsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open ChatGPT' }));
  expect(screen.getByText('Unlock controls to open apps.')).toBeInTheDocument();
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('shows the empty state and the none-installed state', async () => {
  serve({ ...fixture, apps: [] }); const { unmount } = render(<MacAppsCard visible />);
  expect(await screen.findByText('No apps to show.')).toBeInTheDocument();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  unmount(); evictAll();
  serve({ ...fixture, apps: fixture.apps.map(a => ({ ...a, installed: false, running: false, frontmost: false, memoryMb: null, action: null })) });
  render(<MacAppsCard visible />);
  expect(await screen.findByText('None of these apps are installed on this Mac.')).toBeInTheDocument();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

it('says why state is unknown when the probe is missing', async () => {
  serve({ ...fixture, probe: 'missing', reason: 'app state can only be read on macOS; this host has no app probe.',
    apps: fixture.apps.map(a => ({ ...a, installed: null, running: null, frontmost: null, memoryMb: null, action: null })) });
  render(<MacAppsCard visible />);
  expect(await screen.findByText(/Some state is unknown: app state can only be read on macOS/)).toBeInTheDocument();
  expect(screen.getAllByText('Unknown')).toHaveLength(5);
});

it('rejects malformed responses and does not fetch while hidden', async () => {
  serve({ apps: {} }); const { unmount } = render(<MacAppsCard visible />);
  expect(await screen.findByText('App state is unavailable.')).toBeInTheDocument();
  unmount(); evictAll();
  const fetcher = serve(); render(<MacAppsCard visible={false} />);
  expect(fetcher).not.toHaveBeenCalled();
});
