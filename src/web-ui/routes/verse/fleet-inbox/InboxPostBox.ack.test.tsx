import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';
import { fleetRunsQuery } from './fleet-inbox-queries.js';
import { InboxPostBox } from './InboxPostBox.js';

const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};

beforeEach(() => { sessionStorage.clear(); evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('updates the same acknowledgement when a refreshed snapshot gains a leader pass', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T01:44:00Z'));
  let runs = { generatedAt: '2026-11-01T01:44:00Z', leaders: [{ ageSeconds: 540 }] };
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ at: '2026-11-01T01:42:00Z', accepted: true });
    if (String(url).endsWith('/runs')) return Response.json(runs);
    return Response.json({ v: 1, sourceState: 'healthy', entries: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetInboxPane {...props} />);
  await act(() => refetchQuery(fleetRunsQuery.key, () => fleetRunsQuery.fetch(), true));
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt, thought or interjection' }), { target: { value: 'Example message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const line = await screen.findByText('Landed 21:42 · waiting for the next leader pass (about 6 min)');
  expect(line).toHaveAttribute('aria-live', 'polite');
  clock.mockReturnValue(Date.parse('2026-11-01T01:46:00Z'));
  runs = { generatedAt: '2026-11-01T01:46:00Z', leaders: [{ ageSeconds: 60 }] };
  await act(() => refetchQuery(fleetRunsQuery.key, () => fleetRunsQuery.fetch(), true));
  expect(line).toHaveTextContent('Seen by the 21:45 pass');
  expect(line).toHaveAttribute('data-tone', 'ok');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('announces a duplicate and clears it as soon as another post starts', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ at: '2026-11-01T01:42:00Z', duplicate: true }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const onPosted = vi.fn();
  render(<InboxPostBox onPosted={onPosted} />);
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value: 'Example message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const line = await screen.findByText('Already in the inbox (same text within the dedupe window)');
  expect(line).toHaveAttribute('data-tone', 'warning');
  expect(onPosted).not.toHaveBeenCalled();
  fireEvent.change(box, { target: { value: 'Another example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(line).toBeEmptyDOMElement();
  await act(async () => { finish(Response.json({ at: '2026-11-01T01:42:00Z', accepted: true })); });
  expect(onPosted).toHaveBeenCalledWith('Another example');
});
