import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../data/cache.js';
import { fleetLedgerQuery } from '../../routes/verse/usage/fleet-ledger-queries.js';
import { __resetNotificationStoreForTests, getNotificationSnapshot } from './notification-store.js';
import { useNotificationEngine } from './useNotificationEngine.js';

function Harness() {
  useNotificationEngine();
  return null;
}

function healthyControl() {
  return {
    ts: '2026-10-31T12:00:00.000Z',
    security: { available: true, findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0 } },
    limits: [], daemon: { sourceQuality: { sourceState: 'healthy', complete: true } },
  };
}

/** A valid self-update probe answer with nothing pending — the quiet baseline. */
function quietSelfUpdate() {
  return {
    v: 1, sourceState: 'healthy', installedVersion: '3.29.4',
    headSha: 'a'.repeat(40), headAt: '2026-10-31T08:00:00.000Z',
    originSha: 'a'.repeat(40), branch: 'master', behind: 0, ahead: 0, dirty: false,
    lastFetchAt: '2026-10-31T12:00:00.000Z', processStartedAt: '2026-10-31T06:00:00.000Z',
    uptimeSeconds: 21_900, canFastForward: false, lastApply: null,
  };
}

function quietReleasePr() {
  return { v: 1, generatedAt: '2026-10-31T12:00:00.000Z', sourceState: 'healthy', repos: [] };
}

describe('resource ledger notification engine', () => {
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

  it('raises a dead-lane item from the ledger and retires it when the signal returns to ok', async () => {
    const lane = {
      lane: 'claude', running: 2, target: 2, held: false,
      window: 'weekly', usedPct: 40, creditsRemaining: null,
      resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
      projectedExhaustion: null, source: 'status',
      deadSignal: { lane: 'claude', lastFinishes: 5, emptyFailures: 5, state: 'dead' as string },
    };
    const ledger = {
      v: 1, generatedAt: '2026-10-31T12:00:00.000Z',
      sources: { status: 'healthy', apiSpend: 'healthy', jobs: 'healthy' },
      asOf: '2026-10-31T12:00:00.000Z', lanes: [lane], apiSpend: null,
    };
    const sources: Record<string, unknown> = {
      '/api/control': healthyControl(), '/api/fleet': { nextActions: [] },
      '/api/runs': [], '/api/inbox': { pending: 0, proposals: [] },
      '/api/verse/fleet/runs': null, '/api/verse/ops/self-update': quietSelfUpdate(),
      '/api/verse/release-pr': quietReleasePr(), '/api/verse/leader/resources': ledger,
    };
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(sources[path])));
    await act(async () => { render(<Harness />); });
    expect(getNotificationSnapshot().items).toEqual([expect.objectContaining({
      id: 'fleet-lane-dead-claude', category: 'fleet', severity: 'high',
      title: 'claude is producing empty results',
      detail: '5 of the last 5 finishes changed nothing. Dispatch keeps launching into it.',
      actionLabel: 'Open usage',
    })]);

    lane.deadSignal.state = 'ok';
    await act(async () => { await refetchQuery(fleetLedgerQuery.key, () => fleetLedgerQuery.fetch(), true); });
    expect(getNotificationSnapshot().items).toEqual([]);
  });
});
