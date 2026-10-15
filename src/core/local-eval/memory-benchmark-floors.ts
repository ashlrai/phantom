/**
 * Regression floors for the memory quality benchmark, measured on the governed arm at #746 (bf006de5).
 * `npm run bench:memory -- --check` and test/memory-benchmark.test.ts fail when the governed arm drops below any of them.
 * Raise a floor in the same change that raises the measurement; lower one only with a written reason in the PR.
 */
import type { MemoryBenchmarkArmReport, MemoryBenchmarkReport } from './memory-benchmark.js';

type Difficulty = keyof MemoryBenchmarkArmReport['retrievalByDifficulty'];
type Dimension = keyof MemoryBenchmarkArmReport['byDimension'];
/** Case counts and minimum passes. Equal case counts keep a set from being shrunk to meet its floor. */
export const MEMORY_BENCHMARK_FLOORS: {
  readonly caseCount: number; readonly passed: number;
  readonly byDimension: Readonly<Record<Dimension, readonly [cases: number, passed: number]>>;
  readonly retrievalByDifficulty: Readonly<Record<Difficulty, readonly [cases: number, passed: number]>>;
} = Object.freeze({
  caseCount: 296, passed: 220,
  byDimension: Object.freeze({ retrieval: [262, 186], contradiction: [8, 8], temporal: [10, 10], withdrawal: [8, 8], task: [8, 8] } as const),
  retrievalByDifficulty: Object.freeze({
    lexical: [20, 20], inflected: [20, 20], paraphrase: [20, 18], absent: [6, 3],
    'held-out': [40, 34], 'held-out-absent': [6, 4], unseen: [40, 27], 'unseen-absent': [6, 5],
    fresh: [40, 25], 'fresh-absent': [12, 2], 'second-fresh': [40, 27], 'second-fresh-absent': [12, 1],
  } as const),
});

/** Every way the governed arm falls short of the floors; empty when it holds them all. */
export function memoryBenchmarkFloorViolations(report: MemoryBenchmarkReport, arm = 'governed'): string[] {
  const floors = MEMORY_BENCHMARK_FLOORS;
  const found = report.arms.find(entry => entry.arm === arm);
  if (!found) return [`arm ${arm} missing`];
  const violations: string[] = [];
  const at = (label: string, summary: { cases: number; passed: number } | undefined, [cases, passed]: readonly [number, number]): void => {
    if (!summary) { violations.push(`${label}: missing`); return; }
    if (summary.cases !== cases) violations.push(`${label}: ${summary.cases} cases, expected ${cases}`);
    if (summary.passed < passed) violations.push(`${label}: ${summary.passed} passed, floor ${passed}`);
  };
  if (report.caseCount !== floors.caseCount) violations.push(`cases: ${report.caseCount}, expected ${floors.caseCount}`);
  if (found.overall.passed < floors.passed) violations.push(`overall: ${found.overall.passed} passed, floor ${floors.passed}`);
  for (const [dimension, floor] of Object.entries(floors.byDimension)) at(dimension, found.byDimension[dimension as Dimension], floor);
  for (const [difficulty, floor] of Object.entries(floors.retrievalByDifficulty)) at(`retrieval ${difficulty}`, found.retrievalByDifficulty[difficulty as Difficulty], floor);
  const { forbiddenLeaks, receiptForeignEventIds, conflictsSurfaced, conflictsTotal } = found.overall;
  if (forbiddenLeaks) violations.push(`forbidden text leaked ${forbiddenLeaks} times`);
  if (receiptForeignEventIds) violations.push(`receipts named ${receiptForeignEventIds} out-of-scope events`);
  if (conflictsSurfaced < conflictsTotal) violations.push(`contested slots mentioned ${conflictsSurfaced}/${conflictsTotal}`);
  const overBudget = found.cases.flatMap(entry => entry.steps.filter(step => step.failures.includes('budget')).map(() => entry.id));
  if (overBudget.length) violations.push(`over budget: ${[...new Set(overBudget)].join(', ')}`);
  if (found.pendingDecisions.length) violations.push(`pending decisions: ${found.pendingDecisions.map(entry => entry.id).join(', ')}`);
  return violations;
}
