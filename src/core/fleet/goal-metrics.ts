/**
 * core/fleet/goal-metrics.ts: bind each goal to a measured number Phantom
 * already computes (merge speed, DIRTY backlog). Pure: callers pass the
 * readings they already hold. Unknown stays unknown, never 0.
 */
export const GOAL_METRIC_STALE_MS = 30 * 60_000;

export type GoalMetricState = 'live' | 'stale' | 'unknown';
export type GoalMetricId = 'merges-per-hour' | 'open-dirty-prs';

/** One measurement from an existing producer; `previous24h` is the value about a day earlier, when known. */
export interface MetricReading {
  value: number | null;
  observedAt: number | string | null;
  previous24h?: number | null;
}

export interface GoalMetric {
  metric: GoalMetricId | null;
  value: number | null;
  unit: string;
  delta24h: number | null;
  observedAt: number | null;
  state: GoalMetricState;
  /** Why the state is unknown; absent when live or stale. */
  reason?: string;
}

export interface GoalRef { id: string; objective: string }

/** Which metric a goal reports: exact goal id first, then objective wording. */
const METRICS: ReadonlyArray<{ id: GoalMetricId; unit: string; ids: readonly string[]; match: RegExp }> = [
  { id: 'merges-per-hour', unit: '/h', ids: [], match: /\b(merge[sd]?|merging|throughput|ship(?:ping)?|velocity)\b/i },
  { id: 'open-dirty-prs', unit: ' PRs', ids: [], match: /\b(dirty|conflict(?:s|ing)?|backlog|drain)\b/i },
];

const unknown = (metric: GoalMetricId | null, unit: string, reason: string): GoalMetric =>
  ({ metric, value: null, unit, delta24h: null, observedAt: null, state: 'unknown', reason });

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function bindGoalMetrics(
  goals: readonly GoalRef[],
  readings: Partial<Record<GoalMetricId, MetricReading>>,
  now: number,
): Record<string, GoalMetric> {
  const out: Record<string, GoalMetric> = {};
  for (const goal of goals) {
    const def = METRICS.find(m => m.ids.includes(goal.id)) ?? METRICS.find(m => m.match.test(goal.objective));
    if (!def) { out[goal.id] = unknown(null, '', 'no metric is bound to this goal'); continue; }
    const reading = readings[def.id];
    if (!reading || !finite(reading.value)) { out[goal.id] = unknown(def.id, def.unit, 'no reading yet'); continue; }
    const at = typeof reading.observedAt === 'string' ? Date.parse(reading.observedAt) : reading.observedAt;
    if (!finite(at) || at > now) { out[goal.id] = unknown(def.id, def.unit, 'reading has no valid timestamp'); continue; }
    out[goal.id] = {
      metric: def.id,
      value: reading.value,
      unit: def.unit,
      delta24h: finite(reading.previous24h) ? reading.value - reading.previous24h : null,
      observedAt: at,
      state: now - at > GOAL_METRIC_STALE_MS ? 'stale' : 'live',
    };
  }
  return out;
}
