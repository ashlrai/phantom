import { describe, expect, it, vi } from 'vitest';
import type { AppUpdateStatus } from '../src/core/app-update-status.js';
import { clearWorldCacheForTests, readWorldModel } from '../src/core/world/read.js';
import { readUpdatePhase, updatePhaseFromStatus } from '../src/core/world/update-phase.js';

const status: AppUpdateStatus = {
  current: '3.30.8', available: null, deferredReason: null,
  runningJobs: null, runningJobCount: null, unknownJobs: null,
};

const base = {
  nowMs: Date.parse('2026-11-11T00:00:00.000Z'),
  humanStepsFile: '/nonexistent/world-recovery-steps', bottlenecksFile: '/nonexistent/world-recovery-blocks',
  pulls: [], loadRoster: async () => undefined, loadSensors: async () => undefined,
  readClaims: () => ({ source: 'missing' as const, claims: [] }),
} as const;

describe('world update phase recovery', () => {
  it('reports an installed version, including a deferred update, as ok', () => {
    expect(updatePhaseFromStatus(status)).toBe('ok');
    expect(updatePhaseFromStatus({ ...status, available: '3.31.0', deferredReason: 'running-jobs' })).toBe('ok');
    expect(updatePhaseFromStatus({ ...status, current: null })).toBe('unknown');
  });

  it('reports unknown when the status reader throws', () => {
    expect(readUpdatePhase(() => { throw new Error('unavailable'); })).toBe('unknown');
  });

  it.each(['ok', 'unknown'] as const)('projects %s consistently into world and Observe', async (phase) => {
    const readPhase = vi.fn(() => phase);
    const model = await readWorldModel({ ...base, readUpdatePhase: readPhase });
    expect(readPhase).toHaveBeenCalledOnce();
    expect(model.releases.updateCheck).toMatchObject({
      value: phase === 'ok' ? 'ok' : null, freshness: phase === 'ok' ? 'fresh' : 'unknown',
    });
    expect(model.blindSpots.some((spot) => spot.path === 'releases.updateCheck')).toBe(phase === 'unknown');
    expect(model.views.observe.coverage.sources.find((source) => source.id === 'update-check')?.state)
      .toBe(phase === 'ok' ? 'live' : 'unknown');
    expect(model.views.observe.coverage.unknownFields.some((field) => field.path === 'releases.updateCheck'))
      .toBe(phase === 'unknown');
  });

  it('an explicit updatePhase wins over the live reader and never calls it', async () => {
    clearWorldCacheForTests();
    const readPhase = vi.fn(() => 'unknown' as const);
    const model = await readWorldModel({ ...base, updatePhase: 'ok', readUpdatePhase: readPhase });
    expect(readPhase).not.toHaveBeenCalled();
    expect(model.releases.updateCheck).toMatchObject({ value: 'ok', freshness: 'fresh' });
  });

  it('a readUpdatePhase option stays uncached, so a second call re-reads', async () => {
    clearWorldCacheForTests();
    const first = await readWorldModel({ ...base, readUpdatePhase: () => 'ok' });
    expect(first.releases.updateCheck).toMatchObject({ value: 'ok', freshness: 'fresh' });
    const second = await readWorldModel({ ...base, nowMs: base.nowMs + 1, readUpdatePhase: () => 'unknown' });
    expect(second.releases.updateCheck).toMatchObject({ value: null, freshness: 'unknown' });
  });
});
