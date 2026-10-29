import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockReadExperiments = vi.fn();
const mockReadCampaigns = vi.fn();
const mockReadDeliveries = vi.fn();

vi.mock('../../src/core/universe/store.js', () => ({
  readUniverseOverview: (...args: Parameters<typeof import('../../src/core/universe/store.js').readUniverseOverview>) => mockReadExperiments(...args),
}));
vi.mock('../../src/core/universe/campaign-store.js', () => ({
  readUniverseCampaigns: (...args: Parameters<typeof import('../../src/core/universe/campaign-store.js').readUniverseCampaigns>) => mockReadCampaigns(...args),
}));
vi.mock('../../src/core/universe/delivery.js', () => ({
  readUniverseDeliveries: (...args: Parameters<typeof import('../../src/core/universe/delivery.js').readUniverseDeliveries>) => mockReadDeliveries(...args),
}));

describe('readUniverseOverview (overview.ts composition layer)', () => {
  let readOverview: typeof import('../../src/core/universe/overview.js').readUniverseOverview;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns missing-state overview when all three readers are empty', async () => {
    readOverview = (await import('../../src/core/universe/overview.js')).readUniverseOverview;

    mockReadExperiments.mockReturnValue({
      universes: [] as import('../../src/core/universe/types.js').UniverseSummary[],
      sourceState: 'missing' as const,
      reasons: [],
    });
    mockReadCampaigns.mockReturnValue({ campaigns: [], sourceState: 'missing', reasons: [] });
    mockReadDeliveries.mockReturnValue({ deliveries: [], sourceState: 'missing', reasons: [] });

    const result = readOverview();

    expect(result.sourceState).toBe('missing');
    expect(result.reasons).toEqual([]);
    expect(result.universes).toEqual([]);
    expect(result.campaigns).toEqual([]);
    expect(result.deliveryReports).toEqual([]);
  });

  it('escalates to degraded when any single source reports degraded', async () => {
    readOverview = (await import('../../src/core/universe/overview.js')).readUniverseOverview;

    const universeId = 'test-univ';
    const base = {
      universes: [{ manifest: { schemaVersion: 1, id: universeId, name: 'test', objective: 'test', seed: { repo: 'r', revision: 'a'.repeat(40) }, metric: { name: 's', direction: 'maximize', minImprovement: 0 }, budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 100, maxParallel: 1, workerTimeoutMs: undefined }, evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: 100 }, variants: [] }, manifestDigest: 'a'.repeat(64), comparatorDigest: 'a'.repeat(64), runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [] }],
      sourceState: 'healthy' as const,
      reasons: [],
    };

    mockReadExperiments.mockReturnValue(base);
    mockReadCampaigns.mockReturnValue({ campaigns: [], sourceState: 'healthy', reasons: [] });
    mockReadDeliveries.mockReturnValue({ deliveries: [], sourceState: 'degraded', reasons: ['delivery-error'] });

    const result = readOverview();

    expect(result.sourceState).toBe('degraded');
    expect(result.reasons).toContain(`${universeId}: delivery-error`);
  });
});
