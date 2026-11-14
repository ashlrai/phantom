import { describe, expect, it, vi } from 'vitest';
import { clearWorldCacheForTests, readWorldModel } from '../src/core/world/read.js';

const base = {
  nowMs: Date.parse('2026-11-11T00:00:00.000Z'),
  humanStepsFile: '/nonexistent/world-recut-steps', bottlenecksFile: '/nonexistent/world-recut-blocks',
  pulls: [], loadRoster: async () => undefined, loadSensors: async () => undefined,
  readClaims: () => ({ source: 'missing', claims: [] }),
} as const;

describe('world update phase recut', () => {
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
