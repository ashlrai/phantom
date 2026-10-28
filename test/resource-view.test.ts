import { describe, expect, it } from 'vitest';
import { buildResourceView, paceResourceSlots, projectMachineResource, projectPoolResource, RESOURCE_MAX_AGE_MS } from '../src/core/fabric/resource-view.js';

const NOW = Date.parse('2026-10-26T16:00:00.000Z');
const iso = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const reading = (extra = {}) => ({ pool: 'codex-cmp', pctUsed: 40, resetAt: iso(3),
  fetchedAt: iso(0), source: 'codex-cmp-reader', burnRatePctPerHour: 30, ...extra });
const machine = (extra = {}) => ({ schemaVersion: 1, sampledAtMs: NOW, ram: { freeBytes: 25, totalBytes: 100 },
  swap: { usedBytes: 2, growthBytesPerSecond: 0 }, disks: [{ volume: '/', freeBytes: 50 }],
  queueState: 'known', memguardPaused: false, headroom: 4, jobs: [], ...extra });

describe('resource.v1 projection', () => {
  it('projects linear burn from the original reading time', () => {
    expect(projectPoolResource('codex-cmp', reading(), null, NOW + 60_000)).toEqual({
      pool: 'codex-cmp', pctUsed: 40, resetAt: iso(3), fetchedAt: iso(0), source: 'codex-cmp-reader',
      burnRatePerHour: 30, projectedExhaustionAt: iso(2), paceRatio: 1.5, status: 'amber',
    });
  });
  it('treats observed zero burn as green with no finite exhaustion', () => {
    expect(projectPoolResource('codex-cmp', reading({ burnRatePctPerHour: 0 }), null, NOW)).toMatchObject({
      burnRatePerHour: 0, paceRatio: 0, projectedExhaustionAt: null, status: 'green',
    });
  });
  it('reports an already exhausted pool even without burn evidence', () => {
    expect(projectPoolResource('codex-cmp', reading({ pctUsed: 100, burnRatePctPerHour: null }), null, NOW)).toMatchObject({
      projectedExhaustionAt: iso(0), paceRatio: null, status: 'red',
    });
  });
  it('uses two comparable readings, including genuine unchanged usage', () => {
    const before = reading({ pctUsed: 25, fetchedAt: iso(-0.5) });
    expect(projectPoolResource('codex-cmp', reading({ burnRatePctPerHour: null }), before, NOW).burnRatePerHour).toBe(30);
    expect(projectPoolResource('codex-cmp', reading({ burnRatePctPerHour: null }), { ...before, pctUsed: 40 }, NOW).burnRatePerHour).toBe(0);
  });
  it.each([
    { pctUsed: null }, { pctUsed: -1 }, { pctUsed: NaN }, { fetchedAt: iso(1) },
    { fetchedAt: new Date(NOW - RESOURCE_MAX_AGE_MS).toISOString() }, { resetAt: iso(0) },
    { source: 'TEST-untrusted-text' }, { pool: 'codex-personal' },
  ])('keeps invalid, expired or unknown usage unknown: %j', extra => {
    expect(projectPoolResource('codex-cmp', reading(extra), null, NOW)).toMatchObject({ pctUsed: null, status: 'unknown', burnRatePerHour: null });
  });
  it.each([{ resetAt: iso(4) }, { pctUsed: 50 }, { fetchedAt: iso(0) }, { source: 'TEST-untrusted-text' }])(
    'does not invent burn across a changed window/counter/source or repeated reading: %j', extra => {
      const before = reading({ pctUsed: 25, fetchedAt: iso(-0.5), ...extra });
      expect(projectPoolResource('codex-cmp', reading({ burnRatePctPerHour: null }), before, NOW).burnRatePerHour).toBeNull();
    });
  it('keeps a known percentage but unknown pace when reset or burn is missing', () => {
    expect(projectPoolResource('codex-cmp', reading({ resetAt: null }), null, NOW)).toMatchObject({ pctUsed: 40, paceRatio: null, status: 'unknown' });
    expect(projectPoolResource('codex-cmp', reading({ burnRatePctPerHour: null }), null, NOW)).toMatchObject({ pctUsed: 40, paceRatio: null, status: 'unknown' });
  });
  it('survives tiny burn without nonfinite JSON values', () => {
    const view = projectPoolResource('codex-cmp', reading({ burnRatePctPerHour: Number.MIN_VALUE }), null, NOW);
    expect(view.projectedExhaustionAt).toBeNull();
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
  it('derives Devin burn from the saved prior view without renewing the reading time', () => {
    const devin = { pool: 'devin', pctUsed: 25, fetchedAt: new Date(NOW - 120_000).toISOString(), resetAt: iso(1), source: 'devin-api-v3-org-cycle' };
    const prior = buildResourceView({ resources: { devin } }, NOW - 120_000);
    const next = buildResourceView({ resources: { devin: { ...devin, fetchedAt: iso(0), pctUsed: 26 }, view: prior } }, NOW);
    expect(next.pools.find(row => row.pool === 'devin')).toMatchObject({ burnRatePerHour: 30, fetchedAt: iso(0) });
  });
  it('preserves the complete unknown schema, never numeric zero fallbacks', () => {
    expect(buildResourceView({}, NOW)).toEqual({
      schema: 'resource.v1',
      generatedAt: '2026-10-26T16:00:00.000Z',
      pools: ['grok-ultra', 'codex-cmp', 'codex-personal', 'claude-max', 'terra', 'devin'].map(pool => ({
        pool, pctUsed: null, burnRatePerHour: null, resetAt: null,
        projectedExhaustionAt: null, paceRatio: null, status: 'unknown',
        source: null, fetchedAt: null,
      })),
      machine: {
        memFreePct: null, swapUsedPct: null, diskFreePct: null,
        admission: 'unknown', source: null, fetchedAt: null,
      },
      localModels: { status: 'unknown', count: null, fetchedAt: null },
    });
  });
  it('does not expose arbitrary fleet fields or reader errors', () => {
    const view = buildResourceView({ private: 'TEST-private-context', resources: { devin: { status: 'unknown', reason: 'TEST-provider-error' } } }, NOW);
    expect(JSON.stringify(view)).not.toContain('TEST-');
    expect(view.pools.every(row => row.status === 'unknown' && row.pctUsed === null)).toBe(true);
  });
});

describe('Performance telemetry and inventory', () => {
  it('consumes machine headroom and leaves percentages with no denominator unknown', () => {
    expect(projectMachineResource(machine(), NOW)).toEqual({ memFreePct: 25, swapUsedPct: null, diskFreePct: null,
      admission: 'open', source: 'performance-telemetry', fetchedAt: iso(0) });
  });
  it.each([{}, { ram: { freeBytes: null } }, { jobs: [{ rssBytes: null }] }, { queueState: 'unknown' },
    { swap: { usedBytes: 0, growthBytesPerSecond: null } }])('does not equate unavailable headroom with a measured hold: %j', extra => {
    const input = Object.keys(extra).length ? machine({ headroom: 0, ...extra }) : {};
    expect(projectMachineResource(input, NOW).admission).toBe('unknown');
  });
  it('preserves a current veto but expires stale telemetry', () => {
    expect(projectMachineResource(machine({ memguardPaused: true }), NOW).admission).toBe('held');
    expect(projectMachineResource(machine({ headroom: 0 }), NOW).admission).toBe('held');
    expect(projectMachineResource(machine(), NOW + 60_000).admission).toBe('unknown');
  });
  it('distinguishes missing inventory from a verified empty inventory', () => {
    expect(buildResourceView({}, NOW).localModels.count).toBeNull();
    expect(buildResourceView({ resources: { models: { schemaVersion: 1, measuredAt: iso(0), models: [] } } }, NOW).localModels.count).toBe(0);
  });
});

describe('per-pool pacing consumes upstream plans and admitted ceilings', () => {
  const plans = { 'codex-cmp': { allowance: 0.5, periods: [{ startMs: NOW, endMs: NOW + 3_600_000 }] },
    'claude-max': { allowance: 0.5, periods: [{ startMs: NOW, endMs: NOW + 3_600_000 }] } };
  const snapshot = () => buildResourceView({ readings: { 'codex-cmp': reading(),
    'claude-max': reading({ pool: 'claude-max', source: 'claude-max-reader', resetAt: iso(1) }) }, resources: { machine: machine() } }, NOW);
  it('throttles a pool exhausting before its reset while opening another under its own pace', () => {
    expect(paceResourceSlots(snapshot(), { 'codex-cmp': 6, 'claude-max': 6 }, plans, NOW).slice(1, 4)).toEqual([
      { pool: 'codex-cmp', action: 'throttle', slots: 4 }, { pool: 'codex-personal', action: 'unknown', slots: null },
      { pool: 'claude-max', action: 'open', slots: 6 },
    ]);
  });
  it('holds at the pacer allowance and cannot exceed admitted slots', () => {
    const result = paceResourceSlots(snapshot(), { 'codex-cmp': 6 }, { 'codex-cmp': { ...plans['codex-cmp'], allowance: 0 } }, NOW);
    expect(result[1]).toEqual({ pool: 'codex-cmp', action: 'hold', slots: 0 });
  });
  it('withholds decisions when the pacer or signal-slots is missing', () => {
    expect(paceResourceSlots(snapshot(), { 'codex-cmp': 6 }, {}, NOW)[1]?.action).toBe('unknown');
    expect(paceResourceSlots(snapshot(), {}, plans, NOW)[1]?.slots).toBeNull();
  });
  it('rechecks exhaustion and machine freshness at consumption time', () => {
    const view = snapshot();
    view.pools[1]!.projectedExhaustionAt = new Date(NOW + 1000).toISOString();
    expect(paceResourceSlots(view, { 'codex-cmp': 6 }, plans, NOW + 2000)[1]?.action).toBe('hold');
    expect(paceResourceSlots(snapshot(), { 'codex-cmp': 6 }, plans, NOW + 60_000)[1]?.action).toBe('unknown');
  });
});
