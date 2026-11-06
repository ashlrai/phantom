import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../data/cache.js';
import { releasePrQuery } from '../../routes/verse/fleet/release-pr-query.js';
import { __resetNotificationStoreForTests, enableDesktopNotifications, getNotificationSnapshot } from './notification-store.js';
import { useNotificationEngine } from './useNotificationEngine.js';

function Harness() {
  useNotificationEngine();
  return null;
}

describe('release PR notification engine', () => {
  beforeEach(() => {
    markCheckComplete(false);
    evictAll();
    __resetNotificationStoreForTests();
    markCheckComplete(true);
  });
  afterEach(() => {
    markCheckComplete(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('announces a failing PR once and retires it when checks pass', async () => {
    const desktop = vi.fn();
    vi.stubGlobal('Notification', Object.assign(desktop, { permission: 'granted' }));
    await enableDesktopNotifications();
    const pr = { number: 42, title: 'Release 3.30.0', version: '3.30.0', url: 'https://example.test/pr/42',
      openedAt: '2026-10-31T10:00:00Z', updatedAt: '2026-10-31T11:00:00Z', mergeable: 'MERGEABLE',
      checks: [{ name: 'Merge Gate', state: 'fail', url: null }], failing: ['Merge Gate'],
      pending: 0, blocked: true, summary: 'Blocked' };
    const response = { v: 1, generatedAt: pr.updatedAt, sourceState: 'healthy',
      repos: [{ repo: 'ashlrai/phantom', path: '/repo', pr, notes: [] }] };
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/verse/release-pr'
      ? Response.json(response) : new Response('not found', { status: 404 })));
    await act(async () => { render(<Harness />); });
    expect(getNotificationSnapshot().items).toEqual([expect.objectContaining({
      id: 'fleet-release-blocked:ashlrai/phantom:42', severity: 'high',
    })]);
    expect(desktop).toHaveBeenCalledTimes(1);
    expect(desktop).toHaveBeenCalledWith('Release PR #42 is blocked', expect.objectContaining({
      tag: 'fleet-release-blocked:ashlrai/phantom:42', body: expect.stringContaining('Merge Gate failing'),
    }));
    await act(async () => { await refetchQuery(releasePrQuery.key, () => releasePrQuery.fetch(), true); });
    expect(desktop).toHaveBeenCalledTimes(1);
    pr.blocked = false;
    await act(async () => { await refetchQuery(releasePrQuery.key, () => releasePrQuery.fetch(), true); });
    expect(getNotificationSnapshot().items).toEqual([]);
  });
});
