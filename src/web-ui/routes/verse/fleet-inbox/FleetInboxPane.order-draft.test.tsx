import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { openDropJobSheet } from '../fleet-queue/drop-job-sheet-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';

vi.mock('../dock/dock-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane: vi.fn(),
}));
vi.mock('../fleet-queue/drop-job-sheet-store.js', () => ({ openDropJobSheet: vi.fn(() => 'seeded') }));
const entry = { at: '2026-11-01 23:31', source: 'fake desktop', priority: 'P0', text: 'Serve fake feature' };
const trace = { v: 1, generatedAt: '2026-11-02T12:00:00Z', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' }, orders: [] };
const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};
function setup(jobs: unknown[] = [], error = false) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/orders')) return error ? new Response('fake failure', { status: 500 }) : Response.json({ ...trace, orders: [{ ...entry, key: '11-01 23:31', jobs }] });
    if (path.includes('/inbox?')) return Response.json({ v: 1, sourceState: 'healthy', entries: [entry] });
    if (path.endsWith('/runs')) return Response.json({ v: 1, sources: { inbox: 'healthy' }, inbox: [entry] });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<FleetInboxPane {...props} />);
  return fetchMock;
}
beforeEach(() => { evictAll(); vi.clearAllMocks(); vi.mocked(openDropJobSheet).mockReturnValue('seeded'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('drafts an uncited order and reveals the queue', async () => {
  setup();
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Draft job for order at 23:31' }));
  expect(openDropJobSheet).toHaveBeenCalledOnce();
  expect(vi.mocked(openDropJobSheet).mock.calls[0]![0].body).toContain("Goal: Serve Mason's Nov 1 23:31 order:");
  await waitFor(() => expect(openDockPane).toHaveBeenCalledWith('fleet-queue'));
});
it('has no draft action for an order with a citing job', async () => {
  setup([{ id: 'RQ-PHX-FAKE', lane: null, state: 'queued', url: null }]);
  await screen.findByText('1 job');
  expect(screen.queryByRole('button', { name: /Draft job/ })).not.toBeInTheDocument();
});
it('has no draft action when the trace query errors', async () => {
  const fetchMock = setup([], true);
  await screen.findByText(entry.text);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/verse/leader/orders', expect.anything()));
  expect(screen.queryByRole('button', { name: /Draft job/ })).not.toBeInTheDocument();
});
it('explains a kept draft without switching panes', async () => {
  vi.mocked(openDropJobSheet).mockReturnValue('kept');
  setup();
  await userEvent.setup().click(await screen.findByRole('button', { name: /Draft job for order/ }));
  expect(screen.getByText('You have an unsent draft; the fix draft was not applied.')).toBeInTheDocument();
  expect(openDockPane).not.toHaveBeenCalled();
});
