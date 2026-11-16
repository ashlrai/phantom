/**
 * ResourcesBar.firstread.test.tsx — the first open after install or upgrade:
 * the bar itself starts one bounded usage check per never-read resource (the
 * same request "Check again" sends), the row fills with the reading the check
 * returns, and app-session memory keeps the check from ever repeating.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import { reloadResourcesUiForTest, RESOURCES_STORAGE_KEY } from './resources-store.js';
import { resetFirstReadSessionForTest } from './first-read.js';
import { ResourcesBar } from './ResourcesBar.js';

// Polls belong to other surfaces' cadence; nothing here should wait on one.
vi.mock('../shell/section-visibility.js', async (original) => ({
  ...await original<typeof import('../shell/section-visibility.js')>(),
  usePollWhileVisible: vi.fn(),
}));
// The shared seats poll is off so the only seat traffic is the auto-check:
// refreshAccountReading stays real — the POST → readback → merge path runs.
vi.mock('../useSeatsRefresh.js', async (original) => ({
  ...await original<typeof import('../useSeatsRefresh.js')>(),
  useSeatsRefresh: vi.fn(),
}));

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const OBSERVED = new Date(NOW - 60_000).toISOString();
const EXPIRES = new Date(NOW + 3_600_000).toISOString();
const RESET = new Date(NOW + 3 * 86_400_000).toISOString();
const WINDOW = seatWindow({ id: 'seven_day', usedPercent: 28, resetsAt: RESET });
// A seat nothing has read on this computer: no windows, no observation, no check stamp.
const UNREAD = nativeSeat(capacity({ usability: 'unknown', observedAt: null }), { id: 'claude-a', accountId: 'claude-a' });
const READ = nativeSeat(capacity({
  usability: 'ready', observedAt: OBSERVED, quotaExpiresAt: EXPIRES, windows: [WINDOW], binding: WINDOW,
}), { id: 'claude-a', accountId: 'claude-a' });

const refreshCalls = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'POST' && c.path === '/api/verse/seats/refresh');

describe('ResourcesBar first read', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    localStorage.removeItem(RESOURCES_STORAGE_KEY);
    reloadResourcesUiForTest();
    setMutationToken(TEST_TOKEN);
    evictAll();
    resetFirstReadSessionForTest();
  });
  afterEach(() => {
    cleanup();
    evictAll();
    clearMutationToken();
    resetFirstReadSessionForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.removeItem(RESOURCES_STORAGE_KEY);
    reloadResourcesUiForTest();
  });

  it('starts one bounded usage check for a never-read seat, shows the returned reading, and never repeats it', async () => {
    let checked = false;
    const { calls } = installFetch((call) => {
      if (call.method === 'POST' && call.path === '/api/verse/seats/refresh') {
        checked = true;
        return json({
          seatId: 'claude-a', state: 'completed', reading: 'current', reason: 'usage-current',
          observedAt: OBSERVED, expiresAt: EXPIRES, nextCheckAt: null, joined: false,
        });
      }
      switch (call.path) {
        case '/api/verse/bootstrap':
          // The roster always answers unread: a check is a mutation the seats
          // read alone confirms, never the mount-time snapshot.
          return json({ seats: [UNREAD], projects: [], sessions: [], dispatchEnabled: true, localRuntime: {} });
        case '/api/verse/seats':
          return json({ sampledAt: OBSERVED, seats: [checked ? READ : UNREAD], localRuntime: {}, accountTelemetry: { refreshing: false, pendingAccountIds: [] } });
        case '/api/verse/health':
          return json({ checkedAt: OBSERVED, seats: [] });
        case '/api/verse/budget':
          return json({});
        default:
          return json({ error: 'not found' }, 404);
      }
    });

    const view = render(<ResourcesBar expanded now={NOW} />);
    await waitFor(() => expect(refreshCalls(calls)).toHaveLength(1));
    expect(refreshCalls(calls)[0]).toMatchObject({ body: { seatId: 'claude-a' } });
    expect(refreshCalls(calls)[0]!.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    await screen.findByText('72% left');
    expect(screen.getByText(/Current usage/)).toBeInTheDocument();

    // A second mount in the same app session never re-fires the check, even
    // with the seat back to its never-read state (the evicted cache forces the
    // row through the same missing path it took on first open).
    view.unmount();
    evictAll();
    render(<ResourcesBar expanded now={NOW} />);
    await screen.findByText(/No current usage reading/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(refreshCalls(calls)).toHaveLength(1);
  });
});
