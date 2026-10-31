import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fleetRunsNotifyQuery } from './fleet-runs-query.js';
import { NOTIFICATION_CATEGORY_LABEL } from './types.js';
import { evictAll, refetchQuery } from '../../data/cache.js';
import { markCheckComplete } from '../../data/auth-store.js';
import { getVerseUiState, resetVerseUi } from '../../routes/verse/verse-ui-store.js';
import { __resetNotificationStoreForTests, enableDesktopNotifications, getNotificationSnapshot, setMuted } from './notification-store.js';
import { useNotificationEngine } from './useNotificationEngine.js';

class EventSourceStub extends EventTarget {
  static latest: EventSourceStub;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) { super(); EventSourceStub.latest = this; }
  close(): void { /* EventTarget owns no transport or timers. */ }
}

function Harness() {
  useNotificationEngine();
  return null;
}

function healthyControl() {
  return {
    ts: '2026-09-06T12:00:00.000Z',
    security: { available: true, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } },
    limits: [], daemon: { sourceQuality: { sourceState: 'healthy', complete: true } },
  };
}

/** A valid self-update probe answer with nothing pending — the quiet baseline. */
function quietSelfUpdate() {
  return {
    v: 1, sourceState: 'healthy', installedVersion: '3.29.4',
    headSha: 'a'.repeat(40), headAt: '2026-09-06T08:00:00.000Z',
    originSha: 'a'.repeat(40), branch: 'master', behind: 0, ahead: 0, dirty: false,
    lastFetchAt: '2026-09-06T12:00:00.000Z', processStartedAt: '2026-09-06T06:00:00.000Z',
    uptimeSeconds: 21_900, canFastForward: false, lastApply: null,
  };
}

describe('notification refresh channel', () => {
  beforeEach(async () => {
    // Keep the recorded failure inside the production 24-hour notification
    // window; the test exercises refresh behavior, not the wall-clock date.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-06T12:05:00.000Z'));
    markCheckComplete(false);
    evictAll();
    __resetNotificationStoreForTests();
    resetVerseUi();
    vi.stubGlobal('EventSource', EventSourceStub);
    // The app loads its global SSE channel after first paint; mount it here
    // explicitly so this test exercises the real invalidation channel.
    await import('../../data/sse.js');
    markCheckComplete(true);
  });
  afterEach(() => {
    markCheckComplete(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches each source initially without creating a polling timer beyond the self-update cadence', async () => {
    const sources: Record<string, unknown> = {
      '/api/control': healthyControl(), '/api/fleet': { nextActions: [] },
      '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
      '/api/verse/fleet/runs': null, '/api/verse/ops/self-update': quietSelfUpdate(),
    };
    const fetch = vi.fn(async (path: string) => new Response(JSON.stringify(sources[path]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const intervals = vi.spyOn(globalThis, 'setInterval');
    await act(async () => { render(<Harness />); });

    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual(Object.keys(sources).sort());
    // The self-update probe has no SSE event — one 60 s poller, nothing else.
    expect(intervals.mock.calls.map((call) => call[1])).toEqual([60_000]);
    expect(getNotificationSnapshot().items).toHaveLength(0);
  });

  it('reconciles all refreshed sources from real SSE cache invalidations, deduplicating paired observations', async () => {
    const sources: Record<string, unknown> = {
      '/api/control': healthyControl(), '/api/fleet': { nextActions: [] },
      '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
      '/api/verse/fleet/runs': null, '/api/verse/ops/self-update': quietSelfUpdate(),
    };
    const fetch = vi.fn(async (path: string) => new Response(JSON.stringify(sources[path]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await act(async () => { render(<Harness />); });
    expect(getNotificationSnapshot().items).toHaveLength(0);

    sources['/api/control'] = {
      ...healthyControl(),
      security: { available: true, findings: [{ repo: 'sample', title: 'Dependency requires attention', severity: 'critical' }], counts: { critical: 1, high: 0, medium: 0, low: 0 } },
    };
    sources['/api/fleet'] = { nextActions: [{ id: 'check-output', priority: 'high', label: 'Check output', detail: 'A result needs attention.' }] };
    sources['/api/runs'] = [{ id: 'failed-run', goal: 'Try a candidate', status: 'failed', updatedAt: '2026-09-06T12:00:00.000Z' }];
    sources['/api/inbox'] = { pending: 2, proposals: [] };
    await act(async () => {
      for (const event of ['daemon', 'daemon-observation', 'fleet-activity-ping', 'fleet-activity-observation', 'runs', 'inbox']) {
        EventSourceStub.latest.dispatchEvent(new MessageEvent(event, { data: '{}' }));
      }
    });

    expect(getNotificationSnapshot().items.map((item) => item.id).sort()).toEqual([
      'next-action-check-output', 'proposal-backlog', 'run-failed-failed-run', 'security-critical',
    ]);
    for (const path of Object.keys(sources)) {
      // The fleet projection and the self-update probe have no SSE event —
      // they are fetched once at mount and not invalidated by these events.
      const expected = path === '/api/verse/fleet/runs' || path === '/api/verse/ops/self-update' ? 1 : 2;
      expect(fetch.mock.calls.filter(([called]) => called === path)).toHaveLength(expected);
    }
  });

  it('derives the fleet category and retires it when the optional endpoint answers 404', async () => {
    let missing = false;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/verse/fleet/runs') return missing
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify({ generatedAt: '2026-09-06T12:05:00.000Z', paused: false,
          claudeLane: 'down', lanes: [], workers: [], mergesLastHour: { count: null }, drop: null, events: [] }));
      const sources: Record<string, unknown> = { '/api/control': healthyControl(),
        '/api/fleet': { nextActions: [] }, '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
        '/api/verse/ops/self-update': quietSelfUpdate() };
      return new Response(JSON.stringify(sources[path]));
    }));
    await act(async () => { render(<Harness />); });
    expect(getNotificationSnapshot().items).toEqual([expect.objectContaining({
      id: 'fleet-claude-lane-down', category: 'fleet', severity: 'high',
    })]);
    expect(NOTIFICATION_CATEGORY_LABEL.fleet).toBe('Fleet on this Mac');
    missing = true;
    await expect(fleetRunsNotifyQuery.fetch()).resolves.toBeNull();
    await act(async () => {
      await refetchQuery(fleetRunsNotifyQuery.key, () => fleetRunsNotifyQuery.fetch(), true);
    });
    expect(getNotificationSnapshot().items).toEqual([]);
  });

  it('shows merges alongside incidents, sends one desktop alert per merge, and honors fleet mute', async () => {
    const desktop = vi.fn();
    vi.stubGlobal('Notification', Object.assign(desktop, { permission: 'granted' }));
    await enableDesktopNotifications();
    const fleetSnapshot = { generatedAt: '2026-09-06T12:05:00.000Z', paused: false,
      claudeLane: 'down', lanes: [], workers: [], sources: { merges: 'healthy' },
      mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/bridge', number: 1715, title: 'RQ-PHX-INBOXPOST31' }] },
      drop: null, events: [] };
    const sources: Record<string, unknown> = { '/api/control': healthyControl(), '/api/fleet': { nextActions: [] },
      '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] }, '/api/verse/fleet/runs': fleetSnapshot,
      '/api/verse/ops/self-update': quietSelfUpdate() };
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(sources[path])));
    await act(async () => { render(<Harness />); });
    expect(getNotificationSnapshot().items.map((item) => item.id)).toEqual([
      'fleet-claude-lane-down', 'fleet-merge:ashlrai/bridge#1715',
    ]);
    expect(desktop).toHaveBeenCalledTimes(2);
    expect(desktop).toHaveBeenCalledWith('Merged #1715', expect.objectContaining({ tag: 'fleet-merge:ashlrai/bridge#1715' }));
    await act(async () => { await refetchQuery(fleetRunsNotifyQuery.key, () => fleetRunsNotifyQuery.fetch(), true); });
    expect(getNotificationSnapshot().items).toHaveLength(2);
    expect(desktop).toHaveBeenCalledTimes(2);
    act(() => setMuted('fleet', true));
    expect(getNotificationSnapshot().items).toEqual([]);
    fleetSnapshot.mergesLastHour.items.push({ repo: 'ashlrai/bridge', number: 1716, title: 'Another merge' });
    fleetSnapshot.mergesLastHour.count = 2;
    await act(async () => { await refetchQuery(fleetRunsNotifyQuery.key, () => fleetRunsNotifyQuery.fetch(), true); });
    expect(getNotificationSnapshot().items).toEqual([]);
    expect(desktop).toHaveBeenCalledTimes(2);
  });

  it('raises one update-ready item when the self-update probe reports a staged fast-forward', async () => {
    const ready = { ...quietSelfUpdate(), behind: 3, canFastForward: true,
      originSha: 'b'.repeat(40), lastFetchAt: '2026-09-06T12:04:00.000Z' };
    const sources: Record<string, unknown> = {
      '/api/control': healthyControl(), '/api/fleet': { nextActions: [] },
      '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
      '/api/verse/fleet/runs': null, '/api/verse/ops/self-update': ready,
    };
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(sources[path])));
    await act(async () => { render(<Harness />); });

    expect(getNotificationSnapshot().items).toEqual([expect.objectContaining({
      id: 'update-ready:bbbbbbb', category: 'action-required', severity: 'high',
      title: 'Phantom bbbbbbb is ready to install', actionLabel: 'Update now',
    })]);
    // The action is the same surface switch the gear tray's update entry makes.
    act(() => { getNotificationSnapshot().items[0]!.actionRun!(); });
    expect(getVerseUiState().section).toBe('settings');
  });
});
