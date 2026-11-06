import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { resetVerseUi } from '../../routes/verse/verse-ui-store.js';
import { __resetNotificationStoreForTests, getNotificationSnapshot } from './notification-store.js';
import { useNotificationEngine } from './useNotificationEngine.js';

function Harness() { useNotificationEngine(); return null; }

const NOW = '2026-11-01T12:00:00Z';
const trace = { v: 1, generatedAt: NOW, sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '2026-11-01T05:08:00Z', source: 'MASON-INBOX', key: '11-01 00:08', jobs: [
    { id: 'RQ-A', lane: null, state: 'merged', url: 'https://github.com/ashlrai/phantom/pull/12' },
    { id: 'RQ-B', lane: null, state: 'launched', url: null }] }] };
const sources: Record<string, unknown> = {
  '/api/control': { ts: NOW, security: { available: true, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } },
    limits: [], daemon: { sourceQuality: { sourceState: 'healthy', complete: true } } },
  '/api/fleet': { nextActions: [] }, '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
};
const mine = () => getNotificationSnapshot().items.filter(item => item.id.startsWith('order-merged:'));

describe('order-merged notification engine', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
    markCheckComplete(false);
    evictAll();
    __resetNotificationStoreForTests();
    resetVerseUi();
    markCheckComplete(true);
  });
  afterEach(() => { markCheckComplete(false); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('raises one notification for an order with a merged job', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) =>
      Response.json(path === '/api/verse/leader/orders' ? trace : sources[path] ?? null)));
    await act(async () => { render(<Harness />); });
    expect(mine()).toEqual([expect.objectContaining({ id: 'order-merged:11-01 00:08',
      title: 'Your 11-01 00:08 order: 1 of 2 merged', detail: 'merged #12, running' })]);
  });

  it.each(['404', 'network error'])('raises nothing on a %s trace read', async failure => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/verse/leader/orders') {
        if (failure === '404') return new Response('not found', { status: 404 });
        throw new TypeError('network error');
      }
      return Response.json(sources[path] ?? null);
    }));
    await act(async () => { render(<Harness />); });
    expect(mine()).toEqual([]);
  });
});
