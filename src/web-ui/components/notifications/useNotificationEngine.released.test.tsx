import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../data/cache.js';
import { laneTargetsQuery } from '../../routes/verse/ops/lane-targets-queries.js';
import { fleetRunsNotifyQuery } from './fleet-runs-query.js';
import { __resetNotificationStoreForTests, enableDesktopNotifications, getNotificationSnapshot } from './notification-store.js';
import { useNotificationEngine } from './useNotificationEngine.js';

function Harness() { useNotificationEngine(); return null; }
afterEach(() => { markCheckComplete(false); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('announces a release from the control query once and keeps it visible on later refreshes', async () => {
  markCheckComplete(false); evictAll(); __resetNotificationStoreForTests(); markCheckComplete(true);
  const desktop = vi.fn();
  vi.stubGlobal('Notification', Object.assign(desktop, { permission: 'granted' }));
  await enableDesktopNotifications();
  const row = { lane: 'lane-a', held: true, heldReason: 'autobackoff: usage limit', running: 0, target: 1, queued: 7 };
  const runs = { generatedAt: '2026-10-31T12:00:00Z', claudeLane: null, lanes: [row], workers: [],
    mergesLastHour: { count: null }, drop: null, events: [] };
  const target = { lane: 'lane-a', target: 1, floor: 0, ceiling: 2, held: true, heldReason: row.heldReason,
    heldUntil: '2026-10-31T11:00:00Z', lastChange: null as string | null, changedBy: null as string | null };
  const targets = { v: 1 as const, generatedAt: runs.generatedAt, sourceState: 'healthy' as const, lanes: [target] };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/verse/fleet/runs' ? Response.json(runs)
    : path === '/api/verse/fleet/control/lanes' ? Response.json(targets) : new Response('not found', { status: 404 })));
  await act(async () => { render(<Harness />); });
  expect(getNotificationSnapshot().items.some((item) => item.id.startsWith('fleet-lane-released-'))).toBe(false);
  desktop.mockClear();
  target.held = false; target.lastChange = '2026-10-31T12:01:00Z'; target.changedBy = 'reset-detect'; row.held = false;
  await act(async () => { await refetchQuery(laneTargetsQuery.key, () => laneTargetsQuery.fetch(), true);
    await refetchQuery(fleetRunsNotifyQuery.key, () => fleetRunsNotifyQuery.fetch(), true); });
  expect(getNotificationSnapshot().items).toContainEqual(expect.objectContaining({
    id: 'fleet-lane-released-lane-a-2026-10-31T12:01:00Z', detail: 'by reset-detect · autobackoff: usage limit · 7 jobs can start' }));
  expect(desktop).toHaveBeenCalledTimes(1);
  await act(async () => { await refetchQuery(fleetRunsNotifyQuery.key, () => fleetRunsNotifyQuery.fetch(), true); });
  expect(desktop).toHaveBeenCalledTimes(1);
  expect(getNotificationSnapshot().items.filter((item) => item.id.startsWith('fleet-lane-released-'))).toHaveLength(1);
});
