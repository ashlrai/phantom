import { expect, it } from 'vitest';
import { evaluateRoutingPolicy } from '../scripts/evaluators/routing-off-policy.mjs';

it('accounts for observations outside the target policy in IPS', () => {
  const behavior = { small: 0.5, large: 0.5 };
  const target = { small: 1, large: 0 };
  expect(evaluateRoutingPolicy([
    { action: 'small', reward: 1, behavior, target },
    { action: 'large', reward: 1, behavior, target },
  ])).toMatchObject({ observations: 2, ips: 1, snips: 1, effectiveSampleSize: 1 });
});
