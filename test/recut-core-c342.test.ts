import { describe, expect, it } from 'vitest';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import type { RouterMetricsFeed } from '../src/core/fleet/metrics-feed.js';
import type { AshlrConfig } from '../src/core/types.js';

const cfg = {
  version: 1, roots: [], editor: 'cursor', staleDays: 30,
  categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
} as AshlrConfig;

const feed = (): RouterMetricsFeed => ({
  observedAt: '2026-11-10T00:00:00.000Z', windowHours: 6,
  work: [{ pr: 'repo#7', template: 'fix', kind: 'production', merged: true, impactScore: 4 }],
  pools: [{ pool: 'devin', unit: 'sessions', limit: 6, used: 2, observedHours: 3, resetsAt: '2026-11-11T00:00:00.000Z' }],
});

describe('recut core C342: fleet metrics feed lands in fleet status', () => {
  it('threads an injected router metrics reader into the fleet.v1 snapshot', async () => {
    const status = await buildFleetStatus(cfg, { readMetrics: feed });
    expect(status.metrics?.schema).toBe('fleet-metrics.v1');
    expect(status.metrics?.sourceState).toBe('healthy');
    expect(status.metrics?.rollups).toEqual({ total: 1, merged: 1, impactScore: 4 });
    expect(status.metrics?.budgets[0]).toMatchObject({ pool: 'devin', remaining: 4, unit: 'sessions' });
  });

  it('reports the metrics slice unavailable when no reader is supplied', async () => {
    const status = await buildFleetStatus(cfg);
    expect(status.metrics?.schema).toBe('fleet-metrics.v1');
    expect(status.metrics?.sourceState).toBe('unavailable');
    expect(status.metrics?.rollups).toBeNull();
  });
});
