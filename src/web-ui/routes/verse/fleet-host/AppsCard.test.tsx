import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { paneProps } from '../panes/pane-fixtures.test-support.js';
import { AppsCard } from './AppsCard.js';

const at = '2026-11-02T00:00:00Z';
const fixture = { v: 1, generatedAt: at, available: true, apps: [
  { app: 'Codex', running: true, checkedAt: at },
  { app: 'Claude', running: false, checkedAt: at },
  { app: 'Safari', running: null, checkedAt: at },
] };
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function serve(status = 202, body: unknown = fixture, readStatus = 200) {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ app: 'Codex', action: 'restart', code: 'accepted', at }, { status })
    : Response.json(body, { status: readStatus }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const posts = (fetcher: ReturnType<typeof serve>) => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
it('renders app rows with running, stopped and unknown states', async () => {
  serve(); render(<AppsCard {...paneProps()} />);
  expect(await screen.findByText('Codex: running')).toBeInTheDocument();
  expect(screen.getByText('Claude: not running')).toBeInTheDocument();
  expect(screen.getByText('Safari: unknown')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'launch Safari' })).toBeInTheDocument();
});
it('requires two clicks, posts once with the mutation token and refetches', async () => {
  const fetcher = serve(); render(<AppsCard visible />);
  const button = await screen.findByRole('button', { name: 'restart Codex' });
  fireEvent.click(button);
  expect(button).toHaveTextContent('Restart Codex? click again');
  expect(posts(fetcher)).toHaveLength(0);
  fireEvent.click(button); fireEvent.click(button);
  expect(await screen.findByText('Codex: restart — accepted')).toBeInTheDocument();
  expect(posts(fetcher)).toHaveLength(1);
  expect(posts(fetcher)[0]).toEqual(['/api/verse/fleet/apps/action', expect.objectContaining({
    body: JSON.stringify({ app: 'Codex', action: 'restart' }),
    headers: expect.objectContaining({ 'x-ashlr-token': 'a'.repeat(64) }),
  })]);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2));
});
it('expires confirmation after five seconds', async () => {
  const fetcher = serve(); render(<AppsCard visible />);
  const button = await screen.findByRole('button', { name: 'restart Codex' });
  vi.useFakeTimers(); fireEvent.click(button);
  act(() => { vi.advanceTimersByTime(5_000); });
  expect(button).toHaveTextContent('Restart');
  fireEvent.click(button); expect(posts(fetcher)).toHaveLength(0);
});
it('renders nothing for a query 404', async () => {
  const fetcher = serve(202, {}, 404);
  const { container } = render(<AppsCard visible />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
});
it('shows the source checkout requirement without buttons', async () => {
  serve(202, { ...fixture, available: false }); render(<AppsCard visible />);
  expect(await screen.findByText('App control needs a Phantom source checkout.')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it.each([[403, 'App control works only on this Mac.'],
  [404, 'This Phantom server cannot control apps yet; update the app.']])('shows the action %s sentence', async (status, text) => {
  serve(status); render(<AppsCard visible />);
  const button = await screen.findByRole('button', { name: 'restart Codex' });
  fireEvent.click(button); fireEvent.click(button);
  expect(await screen.findByText(text)).toBeInTheDocument();
});
it('does not fetch while hidden', () => {
  const fetcher = serve(); render(<AppsCard visible={false} />);
  expect(fetcher).not.toHaveBeenCalled();
});
