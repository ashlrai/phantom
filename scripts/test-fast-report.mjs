import { isAbsolute, relative } from 'node:path';

export const BUDGET_MS = 20_000;

// Vitest's JSON reporter records each file's start and end in milliseconds.
export function parseVitestReport(report, root) {
  if (!report || !Array.isArray(report.testResults)) {
    throw new Error('Vitest JSON is missing testResults');
  }
  const files = report.testResults.map((result) => {
    if (typeof result.name !== 'string' || !result.name ||
        !Number.isFinite(result.startTime) || !Number.isFinite(result.endTime) ||
        result.endTime < result.startTime) {
      throw new Error('Vitest JSON contains a file without valid timing');
    }
    const file = isAbsolute(result.name) ? relative(root, result.name) : result.name;
    const durationMs = result.endTime - result.startTime;
    return {
      file,
      durationMs,
      status: result.status,
      overBudget: durationMs > BUDGET_MS,
      ...(durationMs > BUDGET_MS ? { suggestion: 'Split this file by independent describe blocks or fixtures and rerun the fast suite.' } : {}),
    };
  });
  files.sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file));
  return { budgetMs: BUDGET_MS, files };
}
