import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueryEntry } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { getPane } from '../panes/pane-registry.js';
import './fleet-inbox.pane.js';
import { FleetInboxPane } from './FleetInboxPane.js';
import { fleetInboxQuery, fleetRunsQuery } from './fleet-inbox-queries.js';

const state = vi.hoisted(() => ({ queries: new Map<string, QueryEntry<unknown>>(), refresh: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: vi.fn((def: { key: string }, options?: { enabled: boolean }) => options?.enabled === false
    ? { data: undefined, error: undefined, status: 'idle', updatedAt: null } : state.queries.get(def.key)),
  useRefetch: () => state.refresh,
}));
const missing = new ApiError('missing', 404, '/fake');
const entries = [
  { at: '2026-01-01 10:00', source: 'Telegram', priority: 'P1', text: 'Review\n<b>literal</b>' },
  { at: '2026-01-02 09:00', source: 'Phantom desktop', priority: 'P0', text: 'Ship fake feature' },
  { at: '2026-01-02 08:00', source: 'terminal', priority: 'P0', text: 'Review fake patch' },
];
const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};
function query(key: string, data: unknown, error?: Error, status: QueryEntry<unknown>['status'] = error ? 'error' : 'success') {
  state.queries.set(key, { data, error, status, updatedAt: null });
}
beforeEach(() => {
  vi.clearAllMocks();
  query(fleetInboxQuery.key, undefined, missing);
  query(fleetRunsQuery.key, { v: 1, sources: { inbox: 'healthy' }, inbox: entries });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('registers for discovery without needing a chat', () => {
  expect(getPane('fleet-inbox')).toMatchObject({ title: "Leaders' inbox", needsSession: false });
});
it('falls back, sorts, filters by source and text, and quotes once', () => {
  const { container } = render(<FleetInboxPane {...props} />);
  expect(screen.getAllByRole('article').map(row => row.textContent)).toEqual([
    expect.stringContaining('Ship fake feature'), expect.stringContaining('Review fake patch'), expect.stringContaining('<b>literal</b>'),
  ]);
  for (const source of ['Telegram', 'Phantom desktop', 'terminal']) expect(screen.getByRole('button', { name: source })).toBeInTheDocument();
  expect(container.querySelector('b')).toBeNull();
  expect(useQuery).toHaveBeenCalledWith(fleetRunsQuery, { enabled: true });
  fireEvent.click(screen.getByRole('button', { name: 'Telegram' }));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Add to message' }));
  expect(props.host.addToMessage).toHaveBeenCalledExactlyOnceWith('> Review\n> <b>literal</b>\n— Telegram, 2026-01-01 10:00 ET');
  fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'patch' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByText('Review fake patch')).toBeInTheDocument();
});
it('prefers the dedicated route and groups entries', () => {
  query(fleetInboxQuery.key, { v: 1, sourceState: 'healthy', entries: Array.from({ length: 100 }, (_, i) => entries[i % 3]) });
  render(<FleetInboxPane {...props} />);
  expect(screen.getAllByRole('article')).toHaveLength(100);
  expect(useQuery).toHaveBeenCalledWith(fleetRunsQuery, { enabled: false });
  expect(within(screen.getByRole('region', { name: '2026-01-01' })).getAllByRole('article')).toHaveLength(34);
});
it('keeps entries when degraded', () => {
  query(fleetRunsQuery.key, { v: 1, sources: { inbox: 'degraded' }, inbox: entries });
  render(<FleetInboxPane {...props} />);
  expect(screen.getByRole('status')).toHaveTextContent('Inbox degraded');
  expect(screen.getAllByRole('article')).toHaveLength(3);
});
it('shows loading, empty, unavailable and both-404 states honestly', () => {
  query(fleetInboxQuery.key, undefined, undefined, 'loading');
  const view = render(<FleetInboxPane {...props} />);
  expect(screen.getByLabelText('Loading inbox')).toBeInTheDocument();
  query(fleetInboxQuery.key, { v: 1, sourceState: 'healthy', entries: [] });
  view.rerender(<FleetInboxPane {...props} />);
  expect(screen.getByText('No orders yet')).toBeInTheDocument();
  query(fleetInboxQuery.key, undefined, missing);
  query(fleetRunsQuery.key, undefined, new Error('fake'));
  view.rerender(<FleetInboxPane {...props} />);
  expect(screen.getByText('Inbox unavailable')).toBeInTheDocument();
  query(fleetRunsQuery.key, undefined, missing);
  view.rerender(<FleetInboxPane {...props} />);
  expect(screen.getByText('Inbox not in this build')).toBeInTheDocument();
});
it('polls every ten seconds only while visible', () => {
  vi.useFakeTimers();
  const view = render(<FleetInboxPane {...props} visible={false} />);
  act(() => vi.advanceTimersByTime(30_000));
  expect(state.refresh).not.toHaveBeenCalled();
  view.rerender(<FleetInboxPane {...props} />);
  act(() => vi.advanceTimersByTime(10_000));
  expect(state.refresh).toHaveBeenCalledTimes(2);
  state.refresh.mockClear();
  view.rerender(<FleetInboxPane {...props} visible={false} />);
  act(() => vi.advanceTimersByTime(30_000));
  expect(state.refresh).not.toHaveBeenCalled();
});
