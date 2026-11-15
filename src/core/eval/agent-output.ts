/** Golden-task evaluation. Runners must return the actual patch they produced. */
import { runBenchmark, type BenchTask, type EngineRunner } from './swe-bench.js';

export interface GoldenTask extends BenchTask {
  /** Literal strings required and forbidden in the patch, respectively. */
  required: string[];
  forbidden: string[];
  /** Maximum changed lines for the task's deliberately scoped solution. */
  maxChangedLines: number;
}
export interface EvalLane { lane: string; model: string; runner: EngineRunner }
export interface OutputScore {
  taskId: string;
  tests: boolean;
  diffQuality: boolean;
  instructions: boolean;
  error?: string;
}
export interface LeaderboardEntry {
  lane: string;
  model: string;
  scores: OutputScore[];
  passRate: number;
}
export interface OutputReport { version: 1; entries: LeaderboardEntry[] }
export interface Regression { lane: string; model: string; taskId: string; dimension: 'tests' | 'diffQuality' | 'instructions' }

/** The task fields golden-output scoring reads (satisfied by GoldenTask and
 * the pass^k suite's PassKTask). */
export interface GoldenTaskScoringView {
  id: string;
  required: string[];
  forbidden: string[];
  maxChangedLines: number;
}

/** Score one golden-task attempt across the three output dimensions. Shared
 * by evaluateOutputs (one attempt per task) and the pass^k suite (N trials). */
export function scoreGoldenOutput(task: GoldenTaskScoringView, diff: string, resolved: boolean, error?: string): OutputScore {
  const changedLines = diff.split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length;
  const valid = !error && changedLines > 0;
  return {
    taskId: task.id,
    tests: resolved && !!valid,
    diffQuality: !!valid && changedLines <= task.maxChangedLines,
    instructions: !!valid && task.required.every(s => diff.includes(s)) && task.forbidden.every(s => !diff.includes(s)),
    ...(error ? { error } : {}),
  };
}

/** Runs sequentially to keep model usage and workspace isolation predictable. */
export async function evaluateOutputs(tasks: GoldenTask[], lanes: EvalLane[]): Promise<OutputReport> {
  if (!tasks.length || !lanes.length) throw new Error('at least one task and lane are required');
  if (new Set(tasks.map(t => t.id)).size !== tasks.length || tasks.some(t => !t.id || !Number.isInteger(t.maxChangedLines) || t.maxChangedLines < 1 || !t.required.length || t.required.some(s => !s) || t.forbidden.some(s => !s))) throw new Error('invalid or duplicate golden task');
  if (lanes.some(l => !l.lane || !l.model) || new Set(lanes.map(l => JSON.stringify([l.lane, l.model]))).size !== lanes.length) throw new Error('invalid or duplicate lane/model');
  const entries: LeaderboardEntry[] = [];
  for (const lane of lanes) {
    const report = await runBenchmark(tasks, { engine: lane.model, engineRunner: lane.runner });
    const scores = report.perTask.map((result, i): OutputScore =>
      scoreGoldenOutput(tasks[i]!, result.diff, result.resolved, result.error));
    entries.push({ lane: lane.lane, model: lane.model, scores, passRate: scores.filter(s => s.tests && s.diffQuality && s.instructions).length / scores.length });
  }
  entries.sort((a, b) => b.passRate - a.passRate || a.lane.localeCompare(b.lane) || a.model.localeCompare(b.model));
  return { version: 1, entries };
}

/** Compare only matching lane/model/task observations; missing observations are not failures. */
export function outputRegressions(previous: OutputReport, current: OutputReport): Regression[] {
  const alerts: Regression[] = [];
  for (const entry of current.entries) {
    const old = previous.entries.find(e => e.lane === entry.lane && e.model === entry.model);
    if (!old) continue;
    for (const score of entry.scores) {
      const before = old.scores.find(s => s.taskId === score.taskId);
      if (!before) continue;
      for (const dimension of ['tests', 'diffQuality', 'instructions'] as const) {
        if (before[dimension] && !score[dimension]) alerts.push({ lane: entry.lane, model: entry.model, taskId: score.taskId, dimension });
      }
    }
  }
  return alerts;
}
