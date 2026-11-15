import { describe, expect, it, vi } from 'vitest';
import type { AppUpdateStatus } from '../src/core/app-update-status.js';
import { readWorldModel } from '../src/core/world/read.js';
import { readUpdatePhase, updatePhaseFromStatus } from '../src/core/world/update-phase.js';

const status: AppUpdateStatus = {
  current: '3.30.8', available: null, deferredReason: null,
  runningJobs: null, runningJobCount: null, unknownJobs: null,
};

describe('world update phase', () => {
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
    const model = await readWorldModel({
      nowMs: Date.parse('2026-11-09T12:00:00.000Z'),
      humanStepsFile: '/nonexistent/world-test-steps', bottlenecksFile: '/nonexistent/world-test-blocks',
      pulls: [], loadRoster: async () => undefined, loadSensors: async () => undefined,
      readClaims: () => ({ source: 'missing', claims: [] }), readUpdatePhase: readPhase,
    });
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
});
