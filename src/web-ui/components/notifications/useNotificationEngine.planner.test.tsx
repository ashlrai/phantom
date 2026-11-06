import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../data/cache.js';
import { plannerPlanQuery } from '../../routes/verse/fleet-dispatch/planner-plan-queries.js';
import { resetVerseUi } from '../../routes/verse/verse-ui-store.js';
import { __resetNotificationStoreForTests, getNotificationSnapshot } from './notification-store.js';
import { useNotificationEngine } from './useNotificationEngine.js';

function Harness() { useNotificationEngine(); return null; }

const plan = { v: 1, generatedAt: '2026-10-31T12:00:00Z', path: '/fake/planner.json', source: 'ok',
  choice: null, nextResetAt: '2026-10-31T13:00:00Z',
  limited: [{ provider: 'codex-personal', status: 'usage-limit', until: '2026-10-31T13:00:00Z' }], health: [] };
const sources: Record<string, unknown> = {
  '/api/control': { ts: plan.generatedAt, security: { available: true, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } },
    limits: [], daemon: { sourceQuality: { sourceState: 'healthy', complete: true } } },
  '/api/fleet': { nextActions: [] }, '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
  '/api/verse/fleet/runs': null, '/api/verse/fleet/control/lanes': null,
  '/api/verse/ops/self-update': null, '/api/verse/release-pr': null, '/api/verse/leader/resources': null,
  '/api/verse/fleet/control/remote-pending': null,
};

describe('planner notification engine', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(plan.generatedAt));
    markCheckComplete(false);
    evictAll();
    __resetNotificationStoreForTests();
    resetVerseUi();
    markCheckComplete(true);
  });
  afterEach(() => { markCheckComplete(false); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('raises the incident and clears it on the next visible poll with a live choice', async () => {
    let current: unknown = plan;
    const fetch = vi.fn(async (path: string) => Response.json(path === '/api/verse/leader/planner/plan' ? current : sources[path] ?? null));
    vi.stubGlobal('fetch', fetch);
    const intervals = vi.spyOn(globalThis, 'setInterval');
    await act(async () => { render(<Harness />); });
    expect(getNotificationSnapshot().items).toContainEqual(expect.objectContaining({ id: 'planner-no-runner',
      severity: 'critical', detail: 'codex-personal usage-limit, resets in 1h.',
      actionLabel: 'Open Dispatch', actionHref: expect.stringContaining('fleet-dispatch') }));
    current = { ...plan, choice: { provider: 'codex-personal', reason: 'available' }, limited: [],
      health: [{ provider: 'codex-personal', status: 'ok', failingSince: null, lastGoodPassAt: null, resetAt: null, reason: null }] };
    const tick = intervals.mock.calls.filter(call => call[1] === 60_000).at(-1)?.[0];
    expect(tick).toBeTypeOf('function');
    await act(async () => { (tick as () => void)(); await refetchQuery(plannerPlanQuery.key, () => plannerPlanQuery.fetch()); });
    expect(fetch.mock.calls.filter(([path]) => path === '/api/verse/leader/planner/plan')).toHaveLength(2);
    expect(getNotificationSnapshot().items.some(item => item.id === 'planner-no-runner')).toBe(false);
  });

  it.each(['404', 'network error'])('does not raise an incident on an initial %s', async failure => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/verse/leader/planner/plan') {
        if (failure === '404') return new Response('not found', { status: 404 });
        throw new TypeError('network error');
      }
      return Response.json(sources[path] ?? null);
    }));
    await act(async () => { render(<Harness />); });
    expect(getNotificationSnapshot().items.filter(item => item.id.startsWith('planner-'))).toEqual([]);
  });
});
