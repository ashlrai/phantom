/** Offline research diagnostic only. No routing, persistence or provider calls.
 * Each row supplies distributions over the same already eligible action set.
 * Rewards are observed bounded outcomes, never predictions for unchosen arms.
 */
function distribution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an action probability map');
  }
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([key, p]) => !key || typeof p !== 'number'
    || !Number.isFinite(p) || p < 0 || p > 1)
    || Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) > 1e-10) {
    throw new Error('Invalid action probability distribution');
  }
  return entries;
}

/** IPS divides by all observations, including target-policy mismatches.
 * SNIPS and ESS are null/zero when no selected action has target mass.
 * No clipping: overflow refuses the estimate instead of concealing instability.
 * Support is checked for ALL target actions, not just the observed action.
 */
export function evaluateRoutingPolicy(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Expected nonempty observations');
  let sumWeights = 0;
  let sumSquares = 0;
  let sumReward = 0;
  let maxWeight = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.reward !== 'number'
      || !Number.isFinite(row.reward) || row.reward < 0 || row.reward > 1) {
      throw new Error('Expected an observed reward in [0, 1]');
    }
    const behavior = distribution(row.behavior);
    const target = distribution(row.target);
    if (behavior.length !== target.length || target.some(([action, p]) =>
      !Object.hasOwn(row.behavior, action) || (p > 0 && row.behavior[action] === 0))) {
      throw new Error('Target action set or support is unavailable');
    }
    if (typeof row.action !== 'string' || !Object.hasOwn(row.behavior, row.action)
      || row.behavior[row.action] <= 0) throw new Error('Observed action has no behavior probability');
    const weight = row.target[row.action] / row.behavior[row.action];
    sumWeights += weight;
    sumSquares += weight * weight;
    sumReward += weight * row.reward;
    maxWeight = Math.max(maxWeight, weight);
  }
  if (![sumWeights, sumSquares, sumReward, sumWeights * sumWeights].every(Number.isFinite)) {
    throw new Error('Importance weights overflow; estimate unavailable');
  }
  return {
    observations: rows.length,
    ips: sumReward / rows.length,
    snips: sumWeights > 0 ? sumReward / sumWeights : null,
    effectiveSampleSize: sumSquares > 0 ? sumWeights * sumWeights / sumSquares : 0,
    maxWeight,
  };
}
