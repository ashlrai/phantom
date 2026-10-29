import { describe, expect, it, vi } from 'vitest';
import { buildFleetMetrics, formatFleetMetrics, readFleetMetrics, readRouterMetricsFeed, type RouterMetricsFeed } from '../src/core/fleet/metrics-feed.js';
import { defaultConfig } from '../src/core/config.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import { cmdFleetWatch, formatFleetStatus } from '../src/cli/fleet.js';

const fixture = (): RouterMetricsFeed => ({
  observedAt: '2026-10-26T12:00:00.000Z', windowHours: 24,
  work: [
    { pr: 'repo#1', template: 'feature', kind: 'production', merged: true, impactScore: 8 },
    { pr: 'repo#2', template: 'experiment', kind: 'exploration', merged: true, impactScore: 3 },
    { pr: 'repo#3', template: 'noise', kind: 'production', merged: false, impactScore: 100 },
  ],
  pools: [{ pool: 'codex-personal', unit: 'credits', limit: 10, used: 8, observedHours: 4, resetsAt: '2026-10-26T14:00:00.000Z' }],
});

describe('fleet metrics v1 dashboard contract', () => {
  it('serializes a stable schema with rollups, shares, impact rankings and budget projections', () => {
    const metrics = JSON.parse(JSON.stringify(buildFleetMetrics(fixture())));
    expect(metrics).toEqual({
      schema: 'fleet-metrics.v1', sourceState: 'healthy', observedAt: '2026-10-26T12:00:00.000Z', windowHours: 24,
      rollups: { total: 3, merged: 2, impactScore: 11 }, productionShare: 2 / 3, explorationShare: 1 / 3,
      topTemplatesToRetire: [{ template: 'noise', total: 1, merged: 0, impactScore: 0 }],
      scoreboard: {
        topPrs: [{ pr: 'repo#1', template: 'feature', impactScore: 8 }, { pr: 'repo#2', template: 'experiment', impactScore: 3 }],
        topTemplates: [
          { template: 'feature', total: 1, merged: 1, impactScore: 8 },
          { template: 'experiment', total: 1, merged: 1, impactScore: 3 },
          { template: 'noise', total: 1, merged: 0, impactScore: 0 },
        ],
      },
      budgets: [{ pool: 'codex-personal', unit: 'credits', limit: 10, used: 8, remaining: 2, burnPerHour: 2,
        projectedExhaustionAt: '2026-10-26T13:00:00.000Z', resetsAt: '2026-10-26T14:00:00.000Z', exhaustionVsReset: 'before-reset' }],
    });
  });

  it('renders every dashboard slice without em dashes', () => {
    const text = formatFleetMetrics(buildFleetMetrics(fixture())).join('\n');
    for (const part of ['production share: 66.7%', 'exploration share: 33.3%', 'retirement candidate: noise',
      'top PR: repo#1', 'top template: feature', 'pool codex-personal: 2 credits remaining', 'burn 2/hour', 'before-reset']) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('\u2014');
  });

  it('marks the local stub unavailable and distinguishes a measured empty window', () => {
    expect(buildFleetMetrics(readRouterMetricsFeed())).toMatchObject({ sourceState: 'unavailable', rollups: null, productionShare: null, budgets: [] });
    expect(buildFleetMetrics({ ...fixture(), work: [], pools: [] })).toMatchObject({ sourceState: 'healthy', rollups: { total: 0, impactScore: 0 }, explorationShare: null });
  });

  it.each([
    ['no observation', 0, 0, 'unknown', null],
    ['no burn', 0, 4, 'no-burn', 0],
    ['at reset', 5, 2, 'at-reset', 2.5],
    ['after reset', 2, 2, 'after-reset', 1],
    ['exhausted', 12, 4, 'before-reset', 3],
  ])('projects %s without infinite dates', (_label, used, observedHours, state, burn) => {
    const feed = fixture();
    Object.assign(feed.pools[0], { used, observedHours });
    const budget = buildFleetMetrics(feed).budgets[0];
    expect(budget.exhaustionVsReset).toBe(state);
    expect(budget.burnPerHour).toBe(burn);
    expect(budget.remaining).toBe(Math.max(0, 10 - used));
  });

  it.each(['duplicate', 'negative', 'invalid-date', 'expired', 'overflow'])('degrades %s evidence', (kind) => {
    const feed = fixture();
    if (kind === 'duplicate') feed.work.push(feed.work[0]);
    if (kind === 'negative') feed.work[0].impactScore = -1;
    if (kind === 'invalid-date') feed.observedAt = 'bad';
    if (kind === 'expired') feed.pools[0].resetsAt = feed.observedAt;
    if (kind === 'overflow') { feed.work[0].impactScore = Number.MAX_VALUE; feed.work[1].impactScore = Number.MAX_VALUE; }
    expect(buildFleetMetrics(feed).sourceState).toBe('degraded');
  });

  it('isolates reader failures and malformed source payloads without exposing error details', () => {
    const failed = readFleetMetrics(() => { throw new Error('private source details'); });
    expect(failed.sourceState).toBe('degraded');
    expect(JSON.stringify(failed)).not.toContain('private');
    expect(readFleetMetrics(() => ({ ...fixture(), work: null! })).sourceState).toBe('degraded');
    expect(readFleetMetrics(() => fixture())).toEqual(buildFleetMetrics(fixture()));
  });

  it('keeps rankings bounded and deterministic without mutating source records', () => {
    const feed = fixture();
    feed.work = Array.from({ length: 20 }, (_, i) => ({ pr: `repo#${String(i).padStart(2, '0')}`, template: `t${i}`, kind: 'production', merged: true, impactScore: 1 }));
    const before = JSON.stringify(feed);
    const first = buildFleetMetrics(feed);
    expect(first.scoreboard.topPrs).toHaveLength(10);
    expect(first.scoreboard.topTemplates).toHaveLength(10);
    expect(JSON.stringify(feed)).toBe(before);
    feed.work.reverse();
    expect(buildFleetMetrics(feed)).toEqual(first);
  });

  it('preserves the independent budget ledger and renders injected metrics in status', async () => {
    const status = await buildFleetStatus({ ...defaultConfig(), roots: [] }, { readMetrics: fixture });
    expect(status.metrics).toEqual(buildFleetMetrics(fixture()));
    expect(status.budgets?.schema).toBe('fleet.budgets.v1');
    expect(JSON.parse(JSON.stringify(status)).metrics.rollups.total).toBe(3);
    expect(formatFleetStatus(status)).toContain('top PR: repo#1');
  });

  it('renders the metrics source state in the watch view', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleetWatch(false)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('Metrics: unavailable (fleet-metrics.v1)');
    } finally {
      log.mockRestore();
    }
  });
});
