/**
 * Regression floors for the memory quality benchmark, measured on the governed arm of #746 with the agent-write fixes.
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
  /** Agent-write ceilings per set: steps that served a wrong or stale fact, and duplicate facts served. */
  readonly agentWrites: Readonly<Record<'tuning' | 'validation', { readonly stepsWithForbidden: number; readonly duplicateWaste: number }>>;
} = Object.freeze({
  caseCount: 500, passed: 371,
  byDimension: Object.freeze({ retrieval: [262, 186], contradiction: [8, 8], temporal: [10, 10], withdrawal: [8, 8], task: [8, 8], 'agent-writes': [204, 151] } as const),
  retrievalByDifficulty: Object.freeze({
    lexical: [20, 20], inflected: [20, 20], paraphrase: [20, 18], absent: [6, 3],
    'held-out': [40, 34], 'held-out-absent': [6, 4], unseen: [40, 27], 'unseen-absent': [6, 5],
    fresh: [40, 25], 'fresh-absent': [12, 2], 'second-fresh': [40, 27], 'second-fresh-absent': [12, 1], 'writes-tuning': [99, 75], 'writes-validation': [105, 76],
  } as const),
  // Raised with W3/W4 (per-write screening): a W1 contradiction case that used to be refused whole now serves and shows its
  // stale fact (tuning 4 -> 5), and the new cosmetic-edit histories hold 1 and 2 duplicates that were served before the fix too.
  agentWrites: Object.freeze({ tuning: { stepsWithForbidden: 5, duplicateWaste: 5 }, validation: { stepsWithForbidden: 9, duplicateWaste: 10 } }),
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
  const { receiptForeignEventIds, conflictsSurfaced, conflictsTotal } = found.overall;
  // Governed histories never leak. Agent-write histories have known open hazards (cross-key contradictions), held to a ceiling.
  const forbiddenLeaks = found.overall.forbiddenLeaks - (found.byDimension['agent-writes']?.forbiddenLeaks ?? 0);
  if (forbiddenLeaks) violations.push(`forbidden text leaked ${forbiddenLeaks} times`);
  for (const [label, ceiling] of Object.entries(floors.agentWrites)) {
    const kinds = found.agentWrites?.[label as 'tuning' | 'validation'];
    if (!kinds) { violations.push(`agent writes ${label}: missing`); continue; }
    const all = Object.entries(kinds).filter(([kind]) => kind !== 'screened').map(([, summary]) => summary);
    const wrong = all.reduce((sum, summary) => sum + summary.stepsWithForbidden, 0), waste = all.reduce((sum, summary) => sum + summary.duplicateWaste, 0);
    if (wrong > ceiling.stepsWithForbidden) violations.push(`agent writes ${label}: wrong or stale fact served in ${wrong} steps, ceiling ${ceiling.stepsWithForbidden}`);
    // A write carrying a credential or private path is never served, in any set.
    if (kinds['secret-write']?.forbiddenLeaks) violations.push(`agent writes ${label}: a credential-bearing write was served ${kinds['secret-write'].forbiddenLeaks} times`);
    if (waste > ceiling.duplicateWaste) violations.push(`agent writes ${label}: ${waste} duplicate facts served, ceiling ${ceiling.duplicateWaste}`);
  }
  if (receiptForeignEventIds) violations.push(`receipts named ${receiptForeignEventIds} out-of-scope events`);
  if (conflictsSurfaced < conflictsTotal) violations.push(`contested slots mentioned ${conflictsSurfaced}/${conflictsTotal}`);
  const overBudget = found.cases.flatMap(entry => entry.steps.filter(step => step.failures.includes('budget')).map(() => entry.id));
  if (overBudget.length) violations.push(`over budget: ${[...new Set(overBudget)].join(', ')}`);
  if (found.pendingDecisions.length) violations.push(`pending decisions: ${found.pendingDecisions.map(entry => entry.id).join(', ')}`);
  return violations;
}
