import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueryEntry } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';
import { fleetInboxQuery, fleetRunsQuery, ordersTraceQuery } from './fleet-inbox-queries.js';

const state = vi.hoisted(() => ({ queries: new Map<string, QueryEntry<unknown>>(), refresh: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: vi.fn((def: { key: string }, options?: { enabled: boolean }) => options?.enabled === false
    ? { data: undefined, error: undefined, status: 'idle', updatedAt: null } : state.queries.get(def.key)),
  useRefetch: () => state.refresh,
}));
const missing = new ApiError('missing', 404, '/fake');
const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};
function query(key: string, data: unknown, error?: Error) {
  state.queries.set(key, { data, error, status: error ? 'error' : 'success', updatedAt: null });
}
function load(inbox: unknown[]) { query(fleetRunsQuery.key, { v: 1, sources: { inbox: 'healthy' }, inbox }); }
beforeEach(() => {
  vi.clearAllMocks();
  query(fleetInboxQuery.key, undefined, missing);
  query(ordersTraceQuery.key, undefined, missing);
});
afterEach(cleanup);

it('hides status asks and misfires behind a toggle', () => {
  load([
    { at: '2026-01-02 09:00', source: 'Phantom desktop', priority: 'P0', text: 'Ship fake feature' },
    { at: '2026-01-02 08:00', source: 'Slack', priority: 'P0', text: 'Phantom status' },
    { at: '2026-01-02 07:00', source: 'terminal', priority: 'P0', text: '--help' },
  ]);
  render(<FleetInboxPane {...props} />);
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByText('Ship fake feature')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '2 status asks / misfires hidden' }));
  const hidden = within(screen.getByRole('region', { name: 'Hidden status asks and misfires' }));
  const rows = hidden.getAllByRole('article');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Phantom status');
  expect(rows[0]).toHaveTextContent('status ask');
  expect(rows[1]).toHaveTextContent('--help');
  expect(rows[1]).toHaveTextContent('misfire');
});
it('renders no hidden control without noise', () => {
  load([{ at: '2026-01-02 09:00', source: 'terminal', priority: 'P0', text: 'Review fake patch' }]);
  render(<FleetInboxPane {...props} />);
  expect(screen.queryByRole('button', { name: /hidden/ })).toBeNull();
});
