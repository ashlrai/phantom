import { describe, expect, it } from 'vitest';
import { evaluateRoutingPolicy } from '../scripts/evaluators/routing-off-policy.mjs';

describe('evaluateRoutingPolicy (recut of #3899)', () => {
  it('reports unit weights and ESS equal to n when behavior and target agree', () => {
    const rows = [
      { action: 'a', reward: 1, behavior: { a: 0.5, b: 0.5 }, target: { a: 0.5, b: 0.5 } },
      { action: 'b', reward: 0, behavior: { a: 0.5, b: 0.5 }, target: { a: 0.5, b: 0.5 } },
      { action: 'a', reward: 0, behavior: { a: 0.5, b: 0.5 }, target: { a: 0.5, b: 0.5 } },
    ];
    expect(evaluateRoutingPolicy(rows))
      .toEqual({ observations: 3, ips: 1 / 3, snips: 1 / 3, effectiveSampleSize: 3, maxWeight: 1 });
  });

  it('handles more than two arms without clipping IPS to [0, 1]', () => {
    const rows = [
      { action: 'c', reward: 1, behavior: { a: 0.5, b: 0.25, c: 0.25 }, target: { a: 0, b: 0, c: 1 } },
    ];
    expect(evaluateRoutingPolicy(rows))
      .toEqual({ observations: 1, ips: 4, snips: 1, effectiveSampleSize: 1, maxWeight: 4 });
  });

  it('keeps target-mismatch rows in the IPS denominator but not in SNIPS weight', () => {
    const rows = [
      { action: 'small', reward: 1, behavior: { small: 0.5, large: 0.5 }, target: { small: 1, large: 0 } },
      { action: 'small', reward: 0.5, behavior: { small: 0.5, large: 0.5 }, target: { small: 1, large: 0 } },
      { action: 'large', reward: 0.5, behavior: { small: 0.5, large: 0.5 }, target: { small: 1, large: 0 } },
    ];
    expect(evaluateRoutingPolicy(rows))
      .toEqual({ observations: 3, ips: 1, snips: 0.75, effectiveSampleSize: 2, maxWeight: 2 });
  });
});
