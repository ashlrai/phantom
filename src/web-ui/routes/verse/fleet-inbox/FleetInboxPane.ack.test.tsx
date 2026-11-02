import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetInboxPane } from './FleetInboxPane.js';
import { fleetRunsQuery } from './fleet-inbox-queries.js';

vi.mock('../../../data/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../data/client.js')>();
  return { ...actual, apiGet: vi.fn() };
});

const props: PaneProps = {
  paneId: 'fleet-inbox', sessionId: null, session: null, visible: true, presentation: 'column', roots: [], events: [], turnFiles: [],
  requests: { terminal: null, preview: null, diff: null },
  host: { addToMessage: vi.fn(), sendToChat: vi.fn(), openPane: vi.fn(), closePane: vi.fn(), openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn() },
};
const entries = [
  { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: 'Seen order' },
  { at: '2026-10-31 00:16', source: 'telegram', priority: 'P0', text: 'Waiting order' },
];
let passAge = 300;
beforeEach(() => {
  evictAll(); sessionStorage.clear(); passAge = 300;
  vi.mocked(apiGet).mockImplementation(async path => path.includes('/inbox?')
    ? { v: 1, sourceState: 'healthy', entries }
    : { v: 1, generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: passAge }] });
});
afterEach(() => { cleanup(); clearMutationToken(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows source and acknowledgement chips and updates after a leader refresh', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T04:20:00Z'));
  render(<FleetInboxPane {...props} />);
  const seen = (await screen.findByText('Seen order')).closest('article')!;
  const waiting = screen.getByText('Waiting order').closest('article')!;
  expect(await within(seen).findByText('Seen by a leader pass')).toBeInTheDocument();
  expect(within(seen).getByText('Phantom desktop')).toBeInTheDocument();
  expect(within(waiting).getByText(/^Waiting · (next pass|pass overdue)/)).toBeInTheDocument();
  expect(within(waiting).getByText('Telegram')).toBeInTheDocument();
  expect(screen.getByText('1 waiting for a leader pass')).toBeInTheDocument();
  passAge = 60;
  await act(() => refetchQuery(fleetRunsQuery.key, () => fleetRunsQuery.fetch(), true));
  expect(within(waiting).getByText('Seen by a leader pass')).toBeInTheDocument();
  expect(screen.queryByText('1 waiting for a leader pass')).not.toBeInTheDocument();
});

it('updates the countdown and marks an overdue pass even when the snapshot stays unchanged', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T04:28:50Z'));
  await act(async () => { render(<FleetInboxPane {...props} />); });
  vi.mocked(apiGet).mockImplementation(() => new Promise(() => {}));
  expect(screen.getByText('Waiting · next pass in ~2 min')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByText('Waiting · next pass in ~1 min')).toBeInTheDocument();
  vi.setSystemTime(new Date('2026-10-31T04:32:50Z'));
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.getByText('Waiting · pass overdue by 3 min')).toHaveAttribute('data-overdue', 'true');
  expect(screen.getByText('1 waiting for a leader pass · leader pass overdue')).toBeInTheDocument();
});

it('polls a newly posted waiting entry at 15 seconds, then returns to the normal interval', async () => {
  vi.useFakeTimers();
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ at: '2026-10-31 00:16' })));
  vi.mocked(apiGet).mockImplementation(async path => path.includes('/inbox?')
    ? { v: 1, sourceState: 'healthy', entries: [entries[0], { ...entries[1], source: 'desktop' }] }
    : { v: 1, generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: passAge }] });
  await act(async () => { render(<FleetInboxPane {...props} />); });
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt, thought or interjection' }), { target: { value: 'Waiting order' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  const runsCalls = () => vi.mocked(apiGet).mock.calls.filter(([path]) => path === '/api/verse/fleet/runs').length;
  const initial = runsCalls();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(runsCalls()).toBe(initial);
  passAge = 60;
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(runsCalls()).toBe(initial + 1);
  expect(within(screen.getByText('Waiting order').closest('article')!).getByText('Seen by a leader pass')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(runsCalls()).toBe(initial + 2);
});
