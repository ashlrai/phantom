/**
 * Offline per-pool value and cost summary over caller-supplied schedule
 * assignment rows.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/telemetry.ts  eventsFromSchedule() per-pool loop -> summarizeScheduleValue()
 *   scheduler/telemetry.ts  value_per_dollar: cost > 0 ? value / cost : null
 *                           -> valuePerDollar, same formula
 *
 * Pure: no I/O, clock, environment, credentials, network, process spawning,
 * telemetry, routing, provider defaults or dispatch. Only the rows passed in
 * are read, and they are never mutated.
 *
 * Provenance is `historical-offline`. The rows describe what a recorded
 * scheduler run assigned. A summary is an inspection aid for that record.
 *
 * Limits:
 *   - expectedValue is a recorded model output. It is not measured task
 *     success, not current quota or runway, and not permission to dispatch.
 *   - A monetaryCost of 0 does not prove that a provider is free. valuePerDollar
 *     is `null` at zero total cost, which means "no ratio". It does not mean
 *     free or infinite.
 *
 * Deliberate divergences from the source:
 *   - The PostHog sink, the event envelope, the `enabled` gate and the Grok
 *     burndown and runway events are not recovered. Only the per-pool
 *     aggregation is.
 *   - Input is validated and invalid input throws. The source would carry NaN
 *     or Infinity into event properties.
 *   - Running totals and the ratio must stay finite. The source did not check.
 *   - Output is frozen and built fresh. Inputs are never written to.
 *   - Pool identity is the caller's string, used unchanged as the grouping key.
 *     The source typed it as SchedulerPoolId, which is not imported here.
 */

/** One recorded assignment. Self-contained so no contract from unmerged work is imported. */
export interface ScheduleValueRow {
  readonly poolId: string;
  /** Finite. May be negative. */
  readonly netValue: number;
  /** Finite and non-negative. */
  readonly monetaryCost: number;
}

export interface PoolValueSummary {
  readonly poolId: string;
  readonly jobs: number;
  /** Sum of netValue over the pool's rows, in input order. */
  readonly expectedValue: number;
  /** Sum of monetaryCost over the pool's rows, in input order. */
  readonly monetaryCost: number;
  /** expectedValue / monetaryCost, or null when the total cost is zero. */
  readonly valuePerDollar: number | null;
  readonly provenance: 'historical-offline';
}

function assertIdentity(row: ScheduleValueRow, index: number): void {
  if (typeof row.poolId !== 'string' || row.poolId.trim() === '') {
    throw new Error(`schedule row ${index}: poolId must be a non-empty string`);
  }
}

function assertFinite(value: unknown, field: string, index: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`schedule row ${index}: ${field} must be a finite number`);
  }
}

/**
 * Group rows by poolId in first-seen order and total each group. Rows are
 * accumulated in input order, matching the source's single pass.
 *
 * Throws on an empty or non-string poolId, a nonfinite netValue or
 * monetaryCost, a negative monetaryCost, or any total or ratio that overflows
 * to a nonfinite value. An empty list returns an empty list.
 */
export function summarizeScheduleValue(rows: readonly ScheduleValueRow[]): readonly PoolValueSummary[] {
  const byPool = new Map<string, { value: number; cost: number; jobs: number }>();
  rows.forEach((row, index) => {
    if (row === null || typeof row !== 'object') {
      throw new Error(`schedule row ${index}: must be an object`);
    }
    assertIdentity(row, index);
    assertFinite(row.netValue, 'netValue', index);
    assertFinite(row.monetaryCost, 'monetaryCost', index);
    if (row.monetaryCost < 0) {
      throw new Error(`schedule row ${index}: monetaryCost must be non-negative`);
    }
    const current = byPool.get(row.poolId) ?? { value: 0, cost: 0, jobs: 0 };
    current.value += row.netValue;
    current.cost += row.monetaryCost;
    current.jobs += 1;
    if (!Number.isFinite(current.value) || !Number.isFinite(current.cost)) {
      throw new Error(`schedule pool aggregate overflowed to a nonfinite value at row ${index}`);
    }
    byPool.set(row.poolId, current);
  });

  return Object.freeze([...byPool.entries()].map(([poolId, total]) => {
    const valuePerDollar = total.cost > 0 ? total.value / total.cost : null;
    if (valuePerDollar !== null && !Number.isFinite(valuePerDollar)) {
      throw new Error('schedule pool valuePerDollar is nonfinite');
    }
    return Object.freeze({
      poolId,
      jobs: total.jobs,
      expectedValue: total.value,
      monetaryCost: total.cost,
      valuePerDollar,
      provenance: 'historical-offline' as const,
    });
  }));
}
