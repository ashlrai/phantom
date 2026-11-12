import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { AppsCard } from './AppsCard.js';
const at = '2026-11-02T00:00:00Z';
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function serve(outcome: string, unreadable = false) {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ app: 'Codex', action: 'ensure', outcome: 'launched' });
    if (String(url).endsWith('/recovery')) {
      if (unreadable) throw new Error('unavailable');
      return Response.json({ v: 1, apps: [{ app: 'Codex', at: Date.now() - 120_000, outcome }] });
    }
    return Response.json({ v: 1, generatedAt: at, available: true, apps: [{ app: 'Codex', running: false, checkedAt: at }] });
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
it.each(['failed', 'gave-up'])('renders %s and retries through the guarded ensure action', async outcome => {
  const fetcher = serve(outcome); render(<AppsCard visible />);
  const button = await screen.findByRole('button', { name: 'Retry recovery Codex' });
  expect(screen.getByText(/recovery (failed|gave up) · 2m ago/)).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  fireEvent.click(button);
  expect(await screen.findByText('Codex: recovery — launched')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith('/api/verse/fleet/apps/action', expect.objectContaining({ body: JSON.stringify({ app: 'Codex', action: 'ensure' }), headers: expect.objectContaining({ 'x-ashlr-token': 'a'.repeat(64) }) }));
});
it('shows recovered age without retry', async () => {
  serve('recovered'); render(<AppsCard visible />);
  expect(await screen.findByText('recovered · 2m ago')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Retry recovery/ })).not.toBeInTheDocument();
});
it('unreadable recovery has a quiet fallback', async () => {
  serve('failed', true); render(<AppsCard visible />);
  expect(await screen.findByText('no recovery recorded')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Retry recovery/ })).not.toBeInTheDocument();
});
it('locked controls cannot send an ensure request', async () => {
  const fetcher = serve('failed'); clearMutationToken(); render(<AppsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry recovery Codex' }));
  await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
