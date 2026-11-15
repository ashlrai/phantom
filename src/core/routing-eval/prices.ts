/**
 * LABELED ESTIMATE for the routing eval only.
 *
 * These rates are not a bill, not a live provider price, and not permission
 * to spend. They are the same conservative mid-tier figures
 * src/core/run/budget.ts uses when it estimates an anthropic call:
 * 3 USD per million input tokens and 15 USD per million output tokens.
 * The eval prints this table with every report. Change the numbers here
 * when the comparison should move.
 */
export const FRONTIER_EVAL_PRICE_TABLE = Object.freeze({
  label: 'labeled estimate' as const,
  model: 'frontier-reference' as const,
  usdPerMillionInputTokens: 3,
  usdPerMillionOutputTokens: 15,
});

/**
 * Integer millionths of a USD. For these rates,
 * micros = inputTokens * inputRate + outputTokens * outputRate,
 * because (tokens / 1_000_000) * rate * 1_000_000 = tokens * rate.
 */
export function frontierEstimateMicros(inputTokens: number, outputTokens: number): number {
  return inputTokens * FRONTIER_EVAL_PRICE_TABLE.usdPerMillionInputTokens
    + outputTokens * FRONTIER_EVAL_PRICE_TABLE.usdPerMillionOutputTokens;
}
