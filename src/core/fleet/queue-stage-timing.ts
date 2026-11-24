/** Observed intervals only; missing evidence never means zero elapsed time. */
export const QUEUE_TIMING_STAGES = ['required_checks', 'queue_admission', 'merge'] as const;
export type QueueTimingStage = typeof QUEUE_TIMING_STAGES[number];
export type QueueStageSample = Record<QueueTimingStage, number | null>;
export const QUEUE_TIMING_LABELS: Record<QueueTimingStage, string> = {
  required_checks: 'Waiting for required checks', queue_admission: 'Waiting to join after readiness', merge: 'Ready in queue until merge',
};
export interface QueueStageStats {
  count: number; missing: number; total_s: number | null;
  p50_s: number | null; p90_s: number | null; max_s: number | null;
}
export interface QueueStageTimingReport {
  schema: 'fleet.queue-stage-timing.v1';
  readOnly: true;
  requiredChecksPreserved: true;
  /** Merged PRs in the report window, including merges with unknown times. */
  prs: number;
  stages: Record<QueueTimingStage, QueueStageStats>;
  /** Stage with the greatest observed total seconds; ties and all-zero totals stay unknown. */
  largest_delay: QueueTimingStage | null;
}

export function queueStageTiming(samples: readonly QueueStageSample[]): QueueStageTimingReport {
  const stages = Object.fromEntries(QUEUE_TIMING_STAGES.map(stage => {
    const values = samples.map(s => s[stage]).filter((s): s is number => s !== null).sort((a, b) => a - b);
    const percentile = (p: number) => values.length ? values[Math.ceil(values.length * p) - 1]! : null;
    return [stage, { count: values.length, missing: samples.length - values.length,
      total_s: values.length ? values.reduce((a, b) => a + b, 0) : null,
      p50_s: percentile(0.5), p90_s: percentile(0.9), max_s: values.at(-1) ?? null }];
  })) as Record<QueueTimingStage, QueueStageStats>;
  const max = Math.max(0, ...QUEUE_TIMING_STAGES.map(stage => stages[stage].total_s ?? 0));
  const winners = QUEUE_TIMING_STAGES.filter(stage => stages[stage].total_s === max);
  return { schema: 'fleet.queue-stage-timing.v1', readOnly: true, requiredChecksPreserved: true,
    prs: samples.length, stages, largest_delay: max > 0 && winners.length === 1 ? winners[0]! : null };
}
