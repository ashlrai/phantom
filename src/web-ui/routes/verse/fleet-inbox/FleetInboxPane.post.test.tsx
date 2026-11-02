import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';

const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};
const token = 'a'.repeat(64);
beforeEach(() => { sessionStorage.clear(); evictAll(); setMutationToken(token); });
afterEach(() => { cleanup(); clearMutationToken(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('refreshes the inbox after posting and highlights the newest matching entry for five seconds', async () => {
  const old = { at: '2026-10-31 00:13', source: 'Phantom desktop', priority: 'P0', text: 'Ship this' };
  const fresh = { ...old };
  let posted = false;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted = true; return Response.json({ at: old.at }); }
    return Response.json({ v: 1, sourceState: 'healthy', entries: posted ? [old, fresh] : [old] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetInboxPane {...props} />);
  await screen.findByText('Ship this');
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt, thought or interjection' }), { target: { value: 'Ship this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(/^Landed 00:13 ·/);
  await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
  expect(fetcher.mock.calls.filter(([url, init]) => String(url).includes('/inbox?') && init?.method === 'GET')).toHaveLength(2);
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/verse/fleet/runs/inbox');
  expect(JSON.parse(String(post[1]!.body))).toEqual({ text: 'Ship this', source: 'Phantom desktop' });
  const rows = screen.getAllByRole('article');
  expect(rows[0]!.className).not.toContain('highlight');
  expect(rows[1]!.className).toContain('highlight');
});

it.each([400, 413])('shows HTTP %s refusal and retains the draft', async status => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ error: 'Message refused.' }, { status })
    : Response.json({ v: 1, sourceState: 'healthy', entries: [] })));
  render(<FleetInboxPane {...props} />);
  const box = screen.getByRole('textbox', { name: 'Prompt, thought or interjection' });
  fireEvent.change(box, { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Message refused.')).toBeInTheDocument();
  expect(box).toHaveValue('Keep this draft');
});

it('expires the highlight after five seconds and cleans up timers when hidden', async () => {
  vi.useFakeTimers();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ at: '2026-10-31 00:13' })
    : Response.json({ v: 1, sourceState: 'healthy', entries: [{ at: '2026-10-31 00:13', source: 'Phantom desktop', priority: 'P0', text: 'Hello' }] })));
  const view = render(<FleetInboxPane {...props} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt, thought or interjection' }), { target: { value: 'Hello' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(screen.getByText(/^Landed 00:13 ·/)).toBeInTheDocument();
  expect(screen.getByRole('article').className).toContain('highlight');
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(within(screen.getByRole('article')).getByText('Hello').closest('article')!.className).not.toContain('highlight');
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt, thought or interjection' }), { target: { value: 'Hello' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  const timerIndex = timers.mock.calls.map(([, delay]) => delay).lastIndexOf(5_000);
  expect(timerIndex).toBeGreaterThanOrEqual(0);
  const highlightTimer = timers.mock.results[timerIndex]!.value;
  view.rerender(<FleetInboxPane {...props} visible={false} />);
  expect(cleared).toHaveBeenCalledWith(highlightTimer);
});
