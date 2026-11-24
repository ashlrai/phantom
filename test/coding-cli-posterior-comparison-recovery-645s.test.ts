import { describe, expect, it } from 'vitest';

import {
  comparePosteriorChoices,
  posteriorArmKey,
  type PosteriorArmState,
  type PosteriorComparisonInput,
  type PosteriorFormulaParams,
} from '../src/core/providers/coding-cli/posterior-comparison.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) computeRegret() and expectedValue().
// All identifiers and numbers are fake.

const JOB = 'fake-job-type';
const FORMULA: PosteriorFormulaParams = {
  latencyWeight: 0.1,
  latencyReferenceMs: 600_000,
  tokenWeight: 0.05,
  tokenReference: 100_000,
  epsilon: 1e-6,
};
const key = (poolId: string, consumer: string | null = null) => posteriorArmKey(JOB, poolId, consumer);
const outcome = (jobId: string, poolId: string, consumer: string | null = null) => ({ jobId, jobType: JOB, poolId, consumer });
const pool = (poolId: string, consumer: string | null = null) => ({ poolId, consumer });

/** Unobserved arm: value 0.5 (success 1/2, no penalties). */
function arm(alpha: number, beta: number, extra: Partial<PosteriorArmState> = {}): PosteriorArmState {
  return { alpha, beta, qualityMean: 1, latencyMean: 0, tokenMean: 0, tokenObservations: 0, observations: 0, ...extra };
}

function run(overrides: Partial<PosteriorComparisonInput>) {
  return comparePosteriorChoices({ outcomes: [], arms: {}, candidates: [], formula: FORMULA, missingArms: 'exclude', ...overrides });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('comparePosteriorChoices (recovered from PR #5952 regret.ts)', () => {
  it('computes success x quality minus latency and token penalties, with clamps', () => {
    // 0.75 * 0.5 - 0.1 * 0.5 - 0.05 * 0.5 = 0.3
    const formula = run({
      outcomes: [outcome('job-formula', 'pool-a')],
      arms: {
        [key('pool-a')]: arm(3, 1, { qualityMean: 0.5, observations: 2, latencyMean: 300_000, tokenMean: 50_000, tokenObservations: 2 }),
        [key('pool-b')]: arm(1, 1),
      },
      candidates: [pool('pool-b')],
    });
    expect(formula.comparisons[0]!.chosenValue).toBeCloseTo(0.3, 12);
    expect(formula.comparisons[0]!.regret).toBeCloseTo(0.2, 12);

    // quality 1.7 clamps to 1; latency 9e6 clamps to 1, so 0.5 - 0.1 = 0.4
    const clamped = run({
      outcomes: [outcome('job-clamp', 'pool-a')],
      arms: { [key('pool-a')]: arm(1, 1, { qualityMean: 1.7, observations: 1, latencyMean: 9e6 }), [key('pool-b')]: arm(3, 1) },
      candidates: [pool('pool-b')],
    });
    expect(clamped.comparisons[0]!.chosenValue).toBeCloseTo(0.4, 12);
    expect(clamped.comparisons[0]!.regret).toBeCloseTo(0.35, 12);
  });

  it('ignores quality and penalties when observations is 0', () => {
    const result = run({
      outcomes: [outcome('job-zero', 'pool-a')],
      arms: { [key('pool-a')]: arm(1, 1, { qualityMean: 0, latencyMean: 9e9, tokenMean: 9e9 }), [key('pool-b')]: arm(1, 1) },
      candidates: [pool('pool-b')],
    });
    expect(result.comparisons).toEqual([]); // both 0.5
  });

  it('keeps consumers distinct and excludes only the chosen consumer', () => {
    const result = run({
      outcomes: [outcome('job-c1', 'grok-fake', 'orchestrator'), outcome('job-c2', 'grok-fake', 'cloud-agent')],
      arms: { [key('grok-fake', 'orchestrator')]: arm(1, 4), [key('grok-fake', 'cloud-agent')]: arm(3, 2) }, // 0.2, 0.6
      candidates: [pool('grok-fake', 'orchestrator'), pool('grok-fake', 'cloud-agent')],
    });
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]).toMatchObject({ recordIndex: 0, chosenConsumer: 'orchestrator', betterPool: 'grok-fake', betterConsumer: 'cloud-agent' });
    expect(result.comparisons[0]!.regret).toBeCloseTo(0.4, 12);
  });

  it('never compares the chosen identity with itself', () => {
    const result = run({
      outcomes: [outcome('job-self', 'pool-a')],
      arms: { [key('pool-a')]: arm(1, 4), [key('pool-b')]: arm(1, 1) }, // 0.2, 0.5
      candidates: [pool('pool-a'), pool('pool-b')],
    });
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.betterPool).toBe('pool-b');
  });

  it('applies a strict epsilon boundary: a gap equal to epsilon is not a comparison', () => {
    const base = {
      outcomes: [outcome('job-eps', 'pool-a')],
      arms: { [key('pool-a')]: arm(1, 1), [key('pool-b')]: arm(3, 1) }, // exact 0.5 and 0.75
      candidates: [pool('pool-b')],
    };
    expect(run({ ...base, formula: { ...FORMULA, epsilon: 0.25 } }).comparisons).toEqual([]);
    expect(run({ ...base, formula: { ...FORMULA, epsilon: 0.24 } }).comparisons[0]!.regret).toBe(0.25);
  });

  it('breaks ties toward the earliest candidate; a tie with the chosen identity is no comparison', () => {
    const arms = { [key('pool-c')]: arm(1, 9), [key('pool-a')]: arm(1, 1), [key('pool-b')]: arm(1, 1) }; // 0.1, 0.5, 0.5
    const ab = run({ outcomes: [outcome('job-tie', 'pool-c')], arms, candidates: [pool('pool-a'), pool('pool-b')] });
    const ba = run({ outcomes: [outcome('job-tie', 'pool-c')], arms, candidates: [pool('pool-b'), pool('pool-a')] });
    expect(ab.comparisons[0]!.betterPool).toBe('pool-a');
    expect(ba.comparisons[0]!.betterPool).toBe('pool-b');

    const equal = run({ outcomes: [outcome('job-eq', 'pool-a')], arms: { [key('pool-a')]: arm(1, 1), [key('pool-b')]: arm(1, 1) }, candidates: [pool('pool-b')] });
    expect(equal.comparisons).toEqual([]);
  });

  it('returns empty comparisons for empty outcomes or empty candidates', () => {
    const arms = { [key('pool-a')]: arm(1, 4) };
    expect(run({ outcomes: [], arms, candidates: [pool('pool-b')] }).comparisons).toEqual([]);
    expect(run({ outcomes: [outcome('job-none', 'pool-a')], arms, candidates: [] }).comparisons).toEqual([]);
  });

  it('excludes missing arms by default and labels prior-derived values only when asked', () => {
    const arms = { [key('pool-a')]: arm(1, 9), [key('pool-c')]: arm(3, 7) }; // chosen 0.1, pool-c 0.3
    const candidates = [pool('pool-b'), pool('pool-c')]; // pool-b unmeasured, prior 0.5

    const excluded = run({ outcomes: [outcome('job-miss', 'pool-a')], arms, candidates });
    expect(excluded.comparisons[0]).toMatchObject({ betterPool: 'pool-c', betterValueSource: 'measured' });

    const prior = run({ outcomes: [outcome('job-miss', 'pool-a')], arms, candidates, missingArms: 'prior-derived' });
    expect(prior.comparisons[0]).toMatchObject({ betterPool: 'pool-b', betterValue: 0.5, betterValueSource: 'prior-derived' });

    // Missing chosen arm: dropped under exclude; prior-derived under prior-derived.
    const chosenArms = { [key('pool-c')]: arm(9, 1) }; // 0.9
    expect(run({ outcomes: [outcome('job-x', 'pool-missing')], arms: chosenArms, candidates: [pool('pool-c')] }).comparisons).toEqual([]);
    const chosenPrior = run({ outcomes: [outcome('job-x', 'pool-missing')], arms: chosenArms, candidates: [pool('pool-c')], missingArms: 'prior-derived' });
    expect(chosenPrior.comparisons[0]).toMatchObject({ chosenValue: 0.5, chosenValueSource: 'prior-derived', betterValueSource: 'measured' });
  });

  it('keeps duplicate job records as separate, indexed comparisons', () => {
    const result = run({
      outcomes: [outcome('job-dup', 'pool-a'), outcome('job-dup', 'pool-a')],
      arms: { [key('pool-a')]: arm(1, 9), [key('pool-b')]: arm(1, 1) },
      candidates: [pool('pool-b')],
    });
    expect(result.comparisons.map((c) => [c.jobId, c.recordIndex])).toEqual([['job-dup', 0], ['job-dup', 1]]);
  });

  it('rejects invalid numbers and identities instead of returning NaN', () => {
    const good = {
      outcomes: [outcome('job-bad', 'pool-a')],
      arms: { [key('pool-a')]: arm(1, 1) },
      candidates: [pool('pool-b')],
    };
    const withFormula = (patch: Partial<PosteriorFormulaParams>) => () => run({ ...good, formula: { ...FORMULA, ...patch } });
    const withArm = (patch: Partial<PosteriorArmState>) => () => run({ ...good, arms: { [key('pool-a')]: arm(1, 1, patch) } });
    const cases: Array<[string, () => unknown]> = [
      ['NaN epsilon', withFormula({ epsilon: Number.NaN })],
      ['negative epsilon', withFormula({ epsilon: -1 })],
      ['zero latency reference', withFormula({ latencyReferenceMs: 0 })],
      ['infinite token reference', withFormula({ tokenReference: Number.POSITIVE_INFINITY })],
      ['negative token weight', withFormula({ tokenWeight: -0.1 })],
      ['NaN alpha', () => run({ ...good, arms: { [key('pool-a')]: arm(Number.NaN, 1) } })],
      ['alpha+beta overflow', () => run({ ...good, arms: { [key('pool-a')]: arm(1e308, 1e308) } })],
      ['infinite quality', withArm({ qualityMean: Number.POSITIVE_INFINITY, observations: 1 })],
      ['duplicate candidate', () => run({ ...good, candidates: [pool('pool-b'), pool('pool-b')] })],
      ['empty-string consumer', () => run({ ...good, candidates: [pool('pool-b', '')] })],
      ['NUL in pool id', () => run({ ...good, candidates: [pool('pool\u0000b')] })],
      ['unknown missingArms policy', () => run({ ...good, missingArms: 'maybe' as 'exclude' })],
    ];
    for (const [name, call] of cases) expect(call, name).toThrow();
  });

  it('never mutates frozen inputs and returns the fixed non-claims', () => {
    const frozen = deepFreeze({
      outcomes: [outcome('job-frozen', 'pool-a')],
      arms: { [key('pool-a')]: arm(1, 4), [key('pool-b')]: arm(1, 1) },
      candidates: [pool('pool-b')],
      formula: FORMULA,
      missingArms: 'exclude' as const,
    });
    const before = JSON.stringify(frozen);
    const first = comparePosteriorChoices(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(comparePosteriorChoices(frozen)).toEqual(first);
    expect(first.basis).toBe('posterior-over-supplied-candidates');
    expect(first.claims).toEqual({ counterfactualExecution: false, currentAvailability: false, quota: false, cost: false, dispatchPermission: false });
  });

  it('builds arm keys with the source layout', () => {
    expect(posteriorArmKey('coding', 'pool-a', null)).toBe('coding\u0000pool-a\u0000');
    expect(posteriorArmKey('coding', 'pool-a', 'orchestrator')).toBe('coding\u0000pool-a\u0000orchestrator');
  });
});
