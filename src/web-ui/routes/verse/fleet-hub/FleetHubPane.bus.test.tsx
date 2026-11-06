import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { getDockState, resetDockStore } from '../dock/dock-store.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { FleetHubPane } from './FleetHubPane.js';

const status = { v: 1, source: 'available', retainedCount: 950, retainedBytes: 41 * 1024,
  liveCount: 950, expiredCount: 0, maxMessages: 1024, maxBytes: 1024 * 1024 };
const runs = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'missing', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null };
const rows = ['mason', 'agent', 'all'].map((to, index) => ({ cursor: 851 + index, receivedAt: Date.now() - 1000,
  envelope: { id: `fake-${index}`, from: 'agent', to, priority: 'P2', ttl: 10000, body: 'fake' } }));
const response = (data: unknown, code = 200) => Promise.resolve(Response.json(data, { status: code }));

beforeEach(() => {
  evictAll(); resetDockStore();
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (path.endsWith('/fleet/runs')) return response(runs);
    if (path.endsWith('/agent-bus/status')) return response(status);
    return response({ v: 1, status: 'ok', messages: rows, nextCursor: 853 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows the bus after the first-run card, reads the newest page and opens the pane', async () => {
  render(<FleetHubPane visible />);
  expect(await screen.findByText('No fleet on this Mac yet')).toBeInTheDocument();
  const tile = (await screen.findByText('3 envelopes in the last hour (of the last 100) · 1 for you')).closest('button');
  expect(tile).toHaveAttribute('data-tone', 'warn');
  expect(tile).toHaveTextContent('Store available · 950 of 1024 · 41 KB of 1 MB');
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('after=850&limit=100'))).toBe(true);
  fireEvent.click(tile!);
  expect(getDockState().active).toBe('fleet-bus');
});

it('polls status and page while visible and stops when hidden', async () => {
  vi.useFakeTimers();
  const view = render(<SectionVisibilityProvider visible><FleetHubPane visible /></SectionVisibilityProvider>);
  await act(async () => {});
  await act(async () => {});
  const busCalls = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes('/agent-bus'));
  expect(busCalls()).toHaveLength(2);
  await act(async () => { vi.advanceTimersByTime(15_000); });
  expect(busCalls()).toHaveLength(4);
  view.rerender(<SectionVisibilityProvider visible={false}><FleetHubPane visible /></SectionVisibilityProvider>);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(busCalls()).toHaveLength(4);
});

it('shows the update message when the route is missing', async () => {
  vi.mocked(fetch).mockImplementation((path) => String(path).endsWith('/fleet/runs') ? response(runs) : response({ error: 'fake' }, 404));
  render(<FleetHubPane visible />);
  await waitFor(() => expect(screen.getByText('Update the hub for the durable bus').closest('button')).toHaveAttribute('data-tone', 'unknown'));
});
