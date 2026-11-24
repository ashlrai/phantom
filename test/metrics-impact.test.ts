import { describe, expect, it } from 'vitest';
import {
  deduplicateImpactInputs, IMPACT_VERSION, rankImpactTemplates, scoreImpact,
  type ImpactInput, type ImpactOverride,
} from '../src/core/metrics/impact.js';

const merged: ImpactInput = {
  id: 'ashlrai/phantom#1', repo: 'ashlrai/phantom', template: 'feature', status: 'merged',
  additions: 600, deletions: 150, files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/a.ts', 'docs/a.md'],
  labels: ['impact:capability', 'impact:autonomy', 'impact:fleet-loop', 'impact:released', 'risk:tier-1', 'impact:novel'],
  dependentJobs: 3, criticalPathDepth: 2, repoBreadth: 3, tokens: 120_000,
};
const trivial: ImpactInput = {
  id: 'ashlrai/phantom#2', repo: 'ashlrai/phantom', template: 'cleanup', status: 'merged',
  additions: 2, deletions: 2, files: ['README.md'], labels: ['impact:trivial'], tokens: 1000,
};

describe('versioned impact reward acceptance', () => {
  it('one large landed Tier-1 change outscores ten trivial merges', () => {
    const large = scoreImpact(merged);
    const small = Array.from({ length: 10 }, (_, i) => scoreImpact({ ...trivial, id: `trivial-${i}` }));
    expect(large.version).toBe(IMPACT_VERSION);
    expect(large.reward).toBeGreaterThan(small.reduce((sum, item) => sum + item.reward, 0));
    expect(large.reward).toBeGreaterThan(500);
    expect(large.ambition).toBe(6);
  });

  it('failed bold attempts cost only their tokens and score above empty work', () => {
    const failed = scoreImpact({ ...merged, status: 'failed' });
    const empty = scoreImpact({ ...trivial, status: 'empty' });
    expect(failed.impact).toBe(0);
    expect(failed.reward).toBe(-0.12);
    expect(failed.exploration).toBe(true);
    expect(Object.values(failed.penalties)).toEqual([0, 0, 0, 0]);
    expect(failed.reward).toBeGreaterThan(empty.reward);
  });
  it('large landed impact also beats ten small merges with positive capability credit', () => {
    const small = scoreImpact({ ...trivial, labels: ['impact:capability', 'impact:trivial'] });
    expect(small.reward).toBeGreaterThan(0);
    expect(scoreImpact(merged).reward).toBeGreaterThan(10 * small.reward);
  });

  it('an unfixed revert is negative even with every dimension maximized', () => {
    const maximized: ImpactOverride = {
      capability: 1, autonomy: 1, unblocking: 1, fleetLoop: 1, productionReach: 1,
      repoBreadth: 1, novelty: 1, riskTier: 1,
    };
    const reverted = scoreImpact({ ...merged, reverted: true }, maximized);
    expect(reverted.reward).toBeCloseTo(-25.12);
    expect(scoreImpact({ ...merged, reverted: true, fixedForward: true }, maximized).reward).toBeGreaterThan(0);
  });
});

describe('evidence and penalties', () => {
  it('derives bounded components from tags and dependent graph metadata', () => {
    const result = scoreImpact({ ...merged, labels: [], tags: ['impact:CAPABILITY', 'impact:published'],
      dependentJobs: 100, criticalPathDepth: 100, repoBreadth: 100 });
    expect(result.components).toEqual({ capability: 1, autonomy: 0, unblocking: 1,
      fleetLoop: 0, productionReach: 1, repoBreadth: 1 });
  });

  it('requires exact labels, not prose, and gives no value for diff size alone', () => {
    const result = scoreImpact({ ...merged, labels: ['This adds impact:capability'], dependentJobs: 0,
      criticalPathDepth: 0, repoBreadth: 0, additions: 100000 });
    expect(result.impact).toBe(0);
    expect(result.reward).toBe(-0.12);
  });

  it('honors manual zero values and preserves evidence penalties', () => {
    const result = scoreImpact({ ...merged, churnFiles: 3 }, { capability: 0, novelty: 0, riskTier: 3 });
    expect(result.components.capability).toBe(0);
    expect(result.ambition).toBe(3);
    expect(result.penalties.churn).toBe(6);
  });

  it('penalizes explicit empty merges but does not invent empty evidence', () => {
    expect(scoreImpact({ id: 'x', repo: 'r', status: 'merged' }).penalties.empty).toBe(0);
    const empty = scoreImpact({ ...merged, additions: 0, deletions: 0, files: [], labels: [] });
    expect(empty.penalties.empty).toBe(25);
    expect(empty.penalties.trivial).toBe(0);
  });

  it('does not award pre-merge impact, churn penalties or revert penalties to failed attempts', () => {
    const result = scoreImpact({ ...merged, status: 'failed', churnFiles: 50, reverted: true }, { trivial: true });
    expect(result.reward).toBe(-result.tokenCost);
    expect(result.impact).toBe(0);
  });

  it.each([NaN, Infinity, -1, 0.5])('rejects invalid token quantities %s', tokens => {
    expect(() => scoreImpact({ ...merged, tokens })).toThrow('nonnegative safe integers');
  });

  it.each([NaN, Infinity, -0.1, 1.1])('rejects invalid override dimensions %s', capability => {
    expect(() => scoreImpact(merged, { capability })).toThrow('between 0 and 1');
  });

  it('rejects invalid identities, status and risk tier', () => {
    expect(() => scoreImpact({ ...merged, id: ' ' })).toThrow('identity');
    expect(() => scoreImpact({ ...merged, status: 'done' as 'merged' })).toThrow('status');
    expect(() => scoreImpact(merged, { riskTier: 0 as 1 })).toThrow('risk tier');
  });

  it('caps scope and churn instead of rewarding padded diffs', () => {
    const huge = scoreImpact({ ...merged, additions: 1_000_000, churnFiles: 100_000 });
    expect(huge.ambition).toBe(6);
    expect(huge.penalties.churn).toBe(20);
  });
});

describe('shared UCB template ranking', () => {
  it('uses the identical reward and records failed bold attempts as exploration', () => {
    const failed: ImpactInput = { ...merged, id: 'failed', status: 'failed' };
    const ranks = rankImpactTemplates([merged, failed, trivial]);
    const feature = ranks.find(rank => rank.template === 'feature')!;
    expect(feature.totalReward).toBe(scoreImpact(merged).reward + scoreImpact(failed).reward);
    expect(feature.attempts).toBe(2);
    expect(feature.explorations).toBe(1);
    expect(ranks[0].template).toBe('feature');
  });

  it('has finite cold starts and a larger exploration bonus for bold templates', () => {
    const ranks = rankImpactTemplates([{ ...merged, status: 'pending' }, { ...trivial, status: 'pending' }]);
    expect(ranks.every(rank => rank.attempts === 0 && Number.isFinite(rank.score))).toBe(true);
    expect(ranks[0].template).toBe('feature');
    expect(ranks[0].explorationBonus).toBeGreaterThan(ranks[1].explorationBonus);
    expect(ranks.every(rank => rank.totalReward === 0)).toBe(true);
  });

  it('uses canonical identity overrides in ranking', () => {
    const overrides = { [merged.id]: { capability: 0 } };
    expect(rankImpactTemplates([merged], overrides)[0].totalReward)
      .toBe(scoreImpact(merged, overrides[merged.id]).reward);
  });

  it('is deterministic across input order and breaks ties by template name', () => {
    const a = { ...trivial, id: 'a', template: 'a' };
    const b = { ...trivial, id: 'b', template: 'b' };
    expect(rankImpactTemplates([b, a])).toEqual(rankImpactTemplates([a, b]));
    expect(rankImpactTemplates([b, a])[0].template).toBe('a');
  });

  it('deduplicates identical records and rejects conflicting identities', () => {
    const duplicate = { ...merged, files: [...merged.files!].reverse() };
    expect(deduplicateImpactInputs([merged, duplicate])).toHaveLength(1);
    expect(rankImpactTemplates([merged, duplicate])[0].attempts).toBe(1);
    expect(() => rankImpactTemplates([merged, { ...merged, status: 'failed' }])).toThrow('Conflicting');
    expect(deduplicateImpactInputs([merged, { ...merged, repo: 'other' }])).toHaveLength(2);
  });

  it('returns no fabricated recommendations for an empty history', () => {
    expect(rankImpactTemplates([])).toEqual([]);
  });
});
