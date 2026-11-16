import { describe, expect, it } from 'vitest';
import { evaluateRoutingPolicy } from '../scripts/evaluators/routing-off-policy.mjs';

const row = (action: string, reward: number) => ({
  action, reward, behavior: { small: 0.5, large: 0.5 }, target: { small: 1, large: 0 },
});

describe('offline routing evidence', () => {
  it('includes mismatches in the IPS denominator and reports effective sample size', () => {
    expect(evaluateRoutingPolicy([row('small', 1), row('large', 0), row('small', 0), row('large', 1)]))
      .toEqual({ observations: 4, ips: 0.5, snips: 0.5, effectiveSampleSize: 2, maxWeight: 2 });
  });

  it('corrects selection bias in an exactly enumerated unequal-propensity population', () => {
    const observations = Array.from({ length: 10 }, (_, i) => ({
      action: i === 0 ? 'small' : 'large', reward: i === 0 ? 1 : 0,
      behavior: { small: 0.1, large: 0.9 }, target: { small: 0.5, large: 0.5 },
    }));
    const result = evaluateRoutingPolicy(observations);
    expect(result.ips).toBeCloseTo(0.5);
    expect(result.snips).toBeCloseTo(0.5);
    expect(result.effectiveSampleSize).toBeCloseTo(3.6);
    expect(result.maxWeight).toBe(5);
  });

  it('reports no overlap without inventing a normalized reward', () => {
    expect(evaluateRoutingPolicy([row('large', 1)]))
      .toEqual({ observations: 1, ips: 0, snips: null, effectiveSampleSize: 0, maxWeight: 0 });
  });

  it('does not clamp a noisy IPS estimate to a plausible-looking success rate', () => {
    expect(evaluateRoutingPolicy([row('small', 1)]).ips).toBe(2);
  });

  it('rejects unsupported counterfactuals even when the observed action has support', () => {
    expect(() => evaluateRoutingPolicy([{ ...row('small', 1),
      behavior: { small: 1, large: 0 }, target: { small: 0.5, large: 0.5 },
    }])).toThrow('support');
  });

  it('rejects changed candidate sets', () => {
    expect(() => evaluateRoutingPolicy([{ ...row('small', 1), target: { absent: 1 } }]))
      .toThrow('action set');
  });

  it.each([null, undefined, NaN, Infinity, -0.1, 1.1, '1'])('rejects missing or invalid reward %s', (reward) => {
    expect(() => evaluateRoutingPolicy([{ ...row('small', 1), reward }])).toThrow('reward');
  });

  it.each([null, [], {}, { small: 0.2 }, { small: NaN }, { small: Infinity },
    { small: -1, large: 2 }, { small: '1' }])('rejects malformed probabilities %j', (behavior) => {
    expect(() => evaluateRoutingPolicy([{ ...row('small', 1), behavior }])).toThrow();
  });

  it.each(['absent', 'toString'])('rejects an unobserved action %s', (action) => {
    expect(() => evaluateRoutingPolicy([row(action, 1)])).toThrow('Observed action');
  });

  it('rejects an impossible logged choice and numerical overflow', () => {
    expect(() => evaluateRoutingPolicy([{ ...row('large', 1), behavior: { small: 1, large: 0 } }]))
      .toThrow('Observed action');
    expect(() => evaluateRoutingPolicy([{ ...row('small', 1), behavior: { small: Number.MIN_VALUE, large: 1 } }]))
      .toThrow('overflow');
  });

  it('refuses empty logs and preserves input', () => {
    expect(() => evaluateRoutingPolicy([])).toThrow('nonempty');
    const observation = row('small', 1);
    Object.freeze(observation.behavior);
    Object.freeze(observation.target);
    Object.freeze(observation);
    expect(evaluateRoutingPolicy(Object.freeze([observation])).ips).toBe(2);
  });
});
